import { describe, it, expect } from 'vitest';
import {
  SPEC_VERSION, cloneJson, queryName, queryDescription, queryFavorite, queryView,
  queryPanel, queryDashboard, withQuerySpec, patchQuerySpec, patchQueryPanel, patchQueryDashboard,
  upgradeV1Query, cloneV2Query, upgradeSavedQuery, queryContentKey, isPlainObject,
} from '../../src/core/saved-query.js';

const v2 = (spec = {}) => ({ id: 'q1', sql: 'SELECT 1', specVersion: 1, spec });

describe('saved-query model', () => {
  it('patches dashboard fields without aliases and supports field/object removal', () => {
    const query = v2({ dashboard: { role: 'filter', future: { values: [1] } }, panel: { cfg: { type: 'line' } } });
    const changed = patchQueryDashboard(query, { role: 'panel', future2: { ok: true } });
    expect(changed.spec.dashboard).toEqual({ role: 'panel', future: { values: [1] }, future2: { ok: true } });
    changed.spec.dashboard.future.values.push(2);
    expect(query.spec.dashboard.future.values).toEqual([1]);
    expect(patchQueryDashboard(changed, { role: undefined }).spec.dashboard.role).toBeUndefined();
    expect(patchQueryDashboard(changed, null).spec.dashboard).toBeUndefined();
  });
  it('recognizes plain objects and deep-clones unknown JSON objects/arrays', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    const source = { nested: { list: [{ x: 1 }] } };
    const cloned = cloneJson(source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned.nested).not.toBe(source.nested);
    expect(cloned.nested.list).not.toBe(source.nested.list);
    expect(cloneJson('x')).toBe('x');
  });

  it('retains __proto__ as inert JSON data without polluting object prototypes', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"x":1}}}');
    const cloned = cloneJson(source);
    expect(Object.hasOwn(cloned, '__proto__')).toBe(true);
    expect(cloned.__proto__).toEqual({ polluted: true });
    expect(Object.hasOwn(cloned.nested, '__proto__')).toBe(true);
    expect(Object.prototype.polluted).toBeUndefined();
    expect(queryContentKey(v2(source))).toContain('__proto__');
  });

  it('reads known fields with safe defaults without stripping extensions', () => {
    const panel = { cfg: { type: 'table' }, links: [{ url: '/x' }] };
    const dashboard = { role: 'panel', future: { x: 1 } };
    const q = v2({ name: 'Q', description: 'D', favorite: true, view: 'panel', panel, dashboard });
    expect(queryName(q)).toBe('Q');
    expect(queryDescription(q)).toBe('D');
    expect(queryFavorite(q)).toBe(true);
    expect(queryFavorite(v2({ favorite: 'false' }))).toBe(false);
    expect(queryFavorite(v2({ favorite: {} }))).toBe(false);
    expect(queryView(q)).toBe('panel');
    expect(queryPanel(q)).toBe(panel);
    expect(queryDashboard(q)).toBe(dashboard);
    expect(queryName(v2({ name: '  ' }))).toBe('Untitled');
    expect(queryDescription(v2())).toBe('');
    expect(queryFavorite(null)).toBe(false);
    expect(queryView(v2({ view: 1 }))).toBeUndefined();
    expect(queryPanel(v2({ panel: [] }))).toBeUndefined();
    expect(queryDashboard(v2({ dashboard: null }))).toBeUndefined();
  });

  it('replaces/patches complete Specs immutably and treats undefined as deletion', () => {
    const original = v2({ name: 'Old', extension: { values: [1, 2] }, description: 'drop' });
    const replaced = withQuerySpec(original, { name: 'New', extension: original.spec.extension });
    const patched = patchQuerySpec(original, { name: 'Patched', description: undefined });
    expect(replaced).toEqual({ id: 'q1', sql: 'SELECT 1', specVersion: SPEC_VERSION,
      spec: { name: 'New', extension: { values: [1, 2] } } });
    expect(replaced.spec.extension).not.toBe(original.spec.extension);
    expect(patched.spec).toEqual({ name: 'Patched', extension: { values: [1, 2] } });
    expect(original.spec.description).toBe('drop');
    expect(withQuerySpec(null, null)).toEqual({ id: null, sql: '', specVersion: 1, spec: {} });
    expect(patchQuerySpec(original, null).spec).toEqual(original.spec);
  });

  it('patches panel cfg/key while preserving future panel siblings', () => {
    const original = v2({ panel: {
      cfg: { type: 'table', unknown: { a: 1 } }, key: 'old',
      fieldConfig: { defaults: { color: 'red' } }, transformations: [{ id: 'sort' }],
    } });
    const patched = patchQueryPanel(original, { cfg: { type: 'logs', msg: 'message' }, key: undefined });
    expect(patched.spec.panel).toEqual({
      cfg: { type: 'logs', msg: 'message' },
      fieldConfig: { defaults: { color: 'red' } }, transformations: [{ id: 'sort' }],
    });
    expect(original.spec.panel.key).toBe('old');
    expect(patchQueryPanel(patched, null).spec.panel).toBeUndefined();
    expect(patchQueryPanel(v2(), null).spec).toEqual({});
  });

  it('patches literal __proto__ keys as inert own data in Spec and panel', () => {
    const specPatch = JSON.parse('{"__proto__":{"name":"inherited"}}');
    const panelPatch = JSON.parse('{"__proto__":{"cfg":{"type":"text"}}}');
    const specPatched = patchQuerySpec(v2({ name: 'Q' }), specPatch);
    const panelPatched = patchQueryPanel(specPatched, panelPatch);
    expect(Object.hasOwn(specPatched.spec, '__proto__')).toBe(true);
    expect(specPatched.spec.name).toBe('Q');
    expect(Object.hasOwn(panelPatched.spec.panel, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(panelPatched.spec.panel)).toBe(Object.prototype);
  });
});

describe('v1 migration', () => {
  const chart = { cfg: { type: 'line', x: 0, y: [1], series: null }, key: 'k' };

  it('moves supported flat fields and dashboard metadata into Spec', () => {
    const raw = { id: 'q', name: 'Logs', sql: 'SELECT 1', favorite: true,
      description: '  note  ', view: 'json', panel: { cfg: { type: 'logs' }, links: [{ x: 1 }] },
      dashboard: { role: 'filter', extension: [1, 2] }, transient: 'drop' };
    const q = upgradeV1Query(raw);
    expect(q).toEqual({ id: 'q', sql: 'SELECT 1', specVersion: 1, spec: {
      name: 'Logs', favorite: true, description: 'note', view: 'json',
      panel: raw.panel, dashboard: raw.dashboard,
    } });
    expect(q.spec.panel).not.toBe(raw.panel);
    expect(q.spec.dashboard).not.toBe(raw.dashboard);
    expect('transient' in q.spec).toBe(false);
    expect(raw.spec).toBeUndefined();
  });

  it('keeps panel authoritative over chart and removes the compatibility mirror', () => {
    const q = upgradeV1Query({ id: 'q', name: 'A', sql: '1', panel: { cfg: { type: 'logs' } }, chart });
    expect(q.spec.panel).toEqual({ cfg: { type: 'logs' } });
    expect('chart' in q.spec).toBe(false);
    expect('chart' in q).toBe(false);
  });

  it("preserves table-over-chart precedence and maps view:'chart'", () => {
    const table = upgradeV1Query({ name: 'A', sql: '1', chart, view: 'table' });
    expect(table.spec.panel).toEqual({ cfg: { type: 'table', chart: { ...chart.cfg, key: 'k' } } });
    expect(table.spec.view).toBe('table');
    const normal = upgradeV1Query({ name: 'A', sql: '1', chart, view: 'chart' });
    expect(normal.spec.panel).toEqual(chart);
    expect(normal.spec.view).toBe('panel');
  });

  it('omits a null chart key so v1-upgraded panels match the live key-less shape', () => {
    // The live save path stores `{cfg}` (no key) when the schema key is null;
    // emitting `key: null` here would defeat merge dedup against that twin.
    const nullKey = upgradeV1Query({ name: 'A', sql: '1', chart: { cfg: { type: 'line', x: 0, y: [1], series: null } } });
    expect(nullKey.spec.panel).toEqual({ cfg: { type: 'line', x: 0, y: [1], series: null } });
    expect('key' in nullKey.spec.panel).toBe(false);
  });

  it('defaults missing name/favorite, permits SQL-less entries, and omits invalid optional fields', () => {
    const q = upgradeV1Query({ id: '', sql: 7, name: '', favorite: 0, description: ' ', view: 'bad', dashboard: [] });
    expect(q).toEqual({ id: undefined, sql: '', specVersion: 1, spec: { name: 'Untitled', favorite: false } });
    expect(upgradeV1Query(null).spec.name).toBe('Untitled');
  });
});

describe('v2 clone/content identity', () => {
  it('clones supported v2 and upgrades only versionless flat entries', () => {
    const source = v2({ name: 'Q', extension: { a: [1] } });
    const cloned = cloneV2Query(source);
    expect(cloned).toEqual(source);
    expect(cloned.spec.extension).not.toBe(source.spec.extension);
    expect(upgradeSavedQuery(source)).toEqual(source);
    expect(upgradeSavedQuery({ name: 'Old', sql: '1' }).spec.name).toBe('Old');
  });

  it('rejects unsupported/malformed v2 without writing a fallback model', () => {
    expect(() => cloneV2Query(null)).toThrow('must be an object');
    expect(() => cloneV2Query({ specVersion: 2, spec: {} })).toThrow('Unsupported saved-query Spec version: 2');
    expect(() => cloneV2Query({ specVersion: 1, spec: [] })).toThrow('Spec must be an object');
    expect(() => upgradeSavedQuery({ specVersion: 1 })).toThrow('Spec must be an object');
  });

  it('dedupes complete Specs independent of object-key order but not array order', () => {
    const a = v2({ name: 'Q', extension: { b: 2, a: 1 }, list: [1, 2] });
    const b = v2({ list: [1, 2], extension: { a: 1, b: 2 }, name: 'Q' });
    const c = v2({ name: 'Q', extension: { b: 2, a: 1 }, list: [2, 1] });
    expect(queryContentKey(a)).toBe(queryContentKey(b));
    expect(queryContentKey(a)).not.toBe(queryContentKey(c));
    expect(queryContentKey(null)).toBe(JSON.stringify(['', null, {}]));
  });
});
