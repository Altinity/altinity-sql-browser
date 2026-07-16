import { describe, it, expect } from 'vitest';
import { encodeShare, decodeShare } from '../../src/core/share.js';
import { queryPanel } from '../../src/core/saved-query.js';
import { savedQuery } from '../helpers/saved-query.js';

describe('share encode/decode', () => {
  it('round-trips a complete identity-free Spec, including unicode and extensions', () => {
    const query = savedQuery({ id: 'local-id', sql: "SELECT 'café — 日本語'", name: 'Unicode', favorite: true,
      panel: { cfg: { type: 'table' }, fieldConfig: { defaults: { color: 'red' } } },
      dashboard: { role: 'panel' }, extension: { nested: [{ x: 1 }] } });
    const decoded = decodeShare('#' + encodeShare(query));
    expect(decoded).toEqual({ sql: query.sql, specVersion: 1, spec: query.spec });
    expect('id' in decoded).toBe(false);
    expect(decoded.spec.extension).not.toBe(query.spec.extension);
  });

  it('uses the documented v2 wire subset and emits no flat/legacy mirrors', () => {
    const query = savedQuery({ id: 'q', sql: 'SELECT 1', name: 'Q',
      panel: { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'k' } });
    const raw = JSON.parse(decodeURIComponent(escape(atob(encodeShare(query)))));
    expect(raw).toEqual({ __asb: 2, query: { sql: query.sql, specVersion: 1, spec: query.spec } });
    expect(raw.query.id).toBeUndefined();
    expect(raw.chart).toBeUndefined();
    expect(raw.panel).toBeUndefined();
  });

  it('round-trips chart style/display and extension metadata without aliasing', () => {
    const style = {
      curve: 'future-curve', points: 'hide', extension: { dense: true },
    };
    const display = { scale: 'zero', legend: 'show', grid: 'hide', axes: 'hide', extension: { frame: true } };
    const query = savedQuery({ sql: 'SELECT k, v FROM t', panel: {
      cfg: { type: 'line', x: 0, y: [1], series: null, style, display },
    } });
    const decoded = decodeShare(encodeShare(query));
    expect(decoded.spec.panel.cfg.style).toEqual(style);
    expect(decoded.spec.panel.cfg.style).not.toBe(style);
    expect(decoded.spec.panel.cfg.style.extension).not.toBe(style.extension);
    expect(decoded.spec.panel.cfg.display).toEqual(display);
    expect(decoded.spec.panel.cfg.display).not.toBe(display);
    expect(decoded.spec.panel.cfg.display.extension).not.toBe(display.extension);
  });

  it('retains the compatibility sql/panel encode call but writes v2', () => {
    const panel = { cfg: { type: 'text', content: '# note' } };
    const decoded = decodeShare(encodeShare('', panel));
    expect(decoded.sql).toBe('');
    expect(queryPanel(decoded)).toEqual(panel);
    expect(decoded.spec.name).toBe('Shared query');
  });

  it('upgrades legacy tagged chart and panel envelopes', () => {
    const chart = { cfg: { type: 'line', x: 0, y: [1], series: null }, key: 'k' };
    const hash = (payload) => btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    expect(queryPanel(decodeShare(hash({ __asb: 1, sql: 'SELECT 3', chart })))).toEqual(chart);
    const panel = { cfg: { type: 'logs', msg: 'message' } };
    expect(queryPanel(decodeShare(hash({ __asb: 1, sql: 'SELECT 4', panel })))).toEqual(panel);
    expect(queryPanel(decodeShare(hash({ __asb: 1, sql: 'SELECT 2', chart: 'bad' })))).toBeUndefined();
  });

  it('accepts raw SQL links and tolerates a leading hash', () => {
    const raw = btoa(unescape(encodeURIComponent('SELECT 1')));
    expect(decodeShare(raw).sql).toBe('SELECT 1');
    expect(decodeShare('#' + raw).sql).toBe('SELECT 1');
    expect(queryPanel(decodeShare(raw))).toBeUndefined();
    expect(decodeShare(btoa('123')).sql).toBe('123');
  });

  it('returns a safe empty shared query for empty/short/garbage/malformed v2 hashes', () => {
    const empty = { sql: '', specVersion: 1, spec: { name: 'Shared query', favorite: false } };
    expect(decodeShare('')).toEqual(empty);
    expect(decodeShare('#')).toEqual(empty);
    expect(decodeShare(null)).toEqual(empty);
    expect(decodeShare('#@@@@')).toEqual(empty);
    const badV2 = btoa(JSON.stringify({ __asb: 2, query: { sql: 1, specVersion: 2, spec: [] } }));
    expect(decodeShare(badV2)).toEqual(empty);
    expect(decodeShare(btoa(JSON.stringify({ __asb: 2 })))).toEqual(empty);
    const tooDeep = '{"__asb":2,"query":{"sql":"","specVersion":1,"spec":'
      + '{"x":'.repeat(50000) + '0' + '}'.repeat(50000) + '}}';
    const deepHash = btoa(tooDeep);
    const deepDecoded = decodeShare(deepHash);
    expect(deepDecoded.sql).toBe('');
    expect(deepDecoded.spec.name).toBe('Shared query');
  });

  it('rejects malformed canonical input at encode time', () => {
    expect(() => encodeShare({ sql: '1', specVersion: 2, spec: {} })).toThrow('Unsupported saved-query Spec version');
  });
});
