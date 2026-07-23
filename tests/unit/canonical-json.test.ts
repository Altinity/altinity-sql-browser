import { describe, expect, it } from 'vitest';
import {
  canonicalEqual, canonicalJson,
  DASHBOARD_DOCUMENT_SHAPE, PORTABLE_BUNDLE_SHAPE, QUERY_SPEC_SHAPE,
  SAVED_QUERY_SHAPE, STORED_WORKSPACE_SHAPE, FLOW_LAYOUT_SHAPE,
} from '../../src/dashboard/model/canonical-json.js';
import type { CanonicalShape } from '../../src/dashboard/model/canonical-json.js';

describe('canonicalJson primitives and formatting', () => {
  it('encodes primitives and matches JSON.stringify 2-space formatting for open objects', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    const value = { b: 1, a: [2, 3], c: { z: 1, y: 2 } };
    // Open object → keys sorted lexicographically, recursively.
    expect(canonicalJson(value)).toBe('{\n  "a": [\n    2,\n    3\n  ],\n  "b": 1,\n  "c": {\n    "y": 2,\n    "z": 1\n  }\n}');
  });

  it('skips non-JSON members like JSON.stringify and throws on a non-JSON root', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: () => 0 })).toBe('{\n  "b": 1\n}');
    // Non-JSON array member becomes null (JSON.stringify parity).
    expect(canonicalJson([undefined])).toBe('[\n  null\n]');
    expect(() => canonicalJson(undefined)).toThrow('non-JSON root');
    expect(() => canonicalJson(() => 0)).toThrow('non-JSON root');
  });
});

describe('canonical field ordering', () => {
  it('orders schema-defined fields canonically and key-sorts unknown extras after them', () => {
    const shape: CanonicalShape = { order: ['first', 'second'] };
    expect(canonicalJson({ zeta: 1, second: 2, alpha: 3, first: 4 }, shape))
      .toBe('{\n  "first": 4,\n  "second": 2,\n  "alpha": 3,\n  "zeta": 1\n}');
    // Absent declared fields are simply skipped.
    expect(canonicalJson({ second: 2 }, shape)).toBe('{\n  "second": 2\n}');
  });

  it('sorts map-like keys lexicographically, including integer-like keys as strings', () => {
    const shape: CanonicalShape = { map: { order: ['span', 'height'] } };
    // Integer-like map keys must sort as strings ("10" < "2"), never numerically.
    const encoded = canonicalJson({ '2': { height: 'medium', span: 1 }, '10': { span: 2 } }, shape);
    expect(encoded).toBe('{\n  "10": {\n    "span": 2\n  },\n  "2": {\n    "span": 1,\n    "height": "medium"\n  }\n}');
  });

  it('produces identical output for differently-ordered equivalent objects', () => {
    const a = { b: { d: 4, c: 3 }, a: [1, { y: 2, x: 1 }] };
    const b = { a: [1, { x: 1, y: 2 }], b: { c: 3, d: 4 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalEqual(a, b)).toBe(true);
    expect(canonicalEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('documented shapes', () => {
  it('orders a query Spec panel/dashboard, keeping style + variant patches key-sorted', () => {
    const spec = {
      dashboard: {
        sizeHints: { aspectRatio: 2, preferred: 'wide' },
        variants: { zoom: { cfg: { zBefore: 1, aAfter: 2 } }, alpha: { title: 't' } },
        role: 'panel',
      },
      panel: { fieldConfig: { columns: { z: { unit: '%' }, a: { hidden: true } } }, cfg: { y: [1], type: 'bar', x: 0 } },
      name: 'Q',
      timeRanges: [{ to: 'to', from: 'from' }],
    };
    const encoded = canonicalJson(spec, QUERY_SPEC_SHAPE);
    // name before panel before dashboard; cfg type/x/y order; variants key-sorted;
    // sizeHints preferred before aspectRatio; open variant patch key-sorted.
    expect(encoded.indexOf('"name"')).toBeLessThan(encoded.indexOf('"panel"'));
    expect(encoded.indexOf('"panel"')).toBeLessThan(encoded.indexOf('"dashboard"'));
    expect(encoded.indexOf('"type": "bar"')).toBeLessThan(encoded.indexOf('"x": 0'));
    expect(encoded.indexOf('"alpha"')).toBeLessThan(encoded.indexOf('"zoom"'));
    expect(encoded.indexOf('"aAfter"')).toBeLessThan(encoded.indexOf('"zBefore"'));
    expect(encoded.indexOf('"preferred"')).toBeLessThan(encoded.indexOf('"aspectRatio"'));
    expect(encoded.indexOf('"dashboard"')).toBeLessThan(encoded.indexOf('"timeRanges"'));
    expect(encoded.indexOf('"from"')).toBeLessThan(encoded.indexOf('"to"'));
    // field config column map keys sorted lexicographically.
    expect(encoded.indexOf('"a": {')).toBeLessThan(encoded.indexOf('"z": {'));
  });

  it('orders a full stored workspace and bundle deterministically regardless of input order', () => {
    const dashboard = {
      tiles: [{ queryId: 'q1', id: 't1' }],
      filters: [],
      layout: { version: 1, type: 'flow', preset: 'report', items: { t1: { height: 'medium', span: 1 } } },
      revision: 1, title: 'D', id: 'd1', documentVersion: 1,
    };
    const query = { spec: { name: 'Q' }, specVersion: 1, sql: 'SELECT 1', id: 'q1' };
    const workspaceA = { dashboard, queries: [query], name: 'W', id: 'w1', storageVersion: 1 };
    const workspaceB = { storageVersion: 1, id: 'w1', name: 'W', queries: [query], dashboard };
    expect(canonicalJson(workspaceA, STORED_WORKSPACE_SHAPE))
      .toBe(canonicalJson(workspaceB, STORED_WORKSPACE_SHAPE));
    const ws = canonicalJson(workspaceA, STORED_WORKSPACE_SHAPE);
    expect(ws.indexOf('"storageVersion"')).toBeLessThan(ws.indexOf('"queries"'));
    expect(ws.indexOf('"documentVersion"')).toBeLessThan(ws.indexOf('"revision"'));

    const bundle = {
      dashboards: [dashboard], queries: [query], exportedAt: 'x',
      version: 1, format: 'altinity-sql-browser/portable-bundle',
      $schema: 's', metadata: { description: 'd', name: 'n' },
    };
    const b = canonicalJson(bundle, PORTABLE_BUNDLE_SHAPE);
    expect(b.indexOf('"$schema"')).toBeLessThan(b.indexOf('"format"'));
    expect(b.indexOf('"queries"')).toBeLessThan(b.indexOf('"dashboards"'));
    expect(b.indexOf('"name"')).toBeLessThan(b.indexOf('"description"'));
  });

  it('orders flow layout, saved query, and dashboard document field-canonically', () => {
    const flow = canonicalJson({ items: { t1: { height: 'large', span: 3 } }, preset: 'report', version: 1, type: 'flow' }, FLOW_LAYOUT_SHAPE);
    expect(flow.indexOf('"type"')).toBeLessThan(flow.indexOf('"version"'));
    expect(flow.indexOf('"span"')).toBeLessThan(flow.indexOf('"height"'));
    const sq = canonicalJson({ spec: {}, specVersion: 1, sql: 's', id: 'q' }, SAVED_QUERY_SHAPE);
    expect(sq.indexOf('"id"')).toBeLessThan(sq.indexOf('"sql"'));
    const doc = canonicalJson({
      tiles: [{ presentation: { override: { b: 1 }, variant: 'v' }, queryId: 'q', id: 't' }],
      filters: [{ defaultActive: true, id: 'f', parameter: 'p' }],
      layout: { type: 'flow', version: 1, config: { z: 1, a: 2 }, fallback: { type: 'flow', version: 1, preset: 'report', items: {} } },
      revision: 2, title: 'T', id: 'd', documentVersion: 1,
    }, DASHBOARD_DOCUMENT_SHAPE);
    expect(doc.indexOf('"variant"')).toBeLessThan(doc.indexOf('"override"'));
    expect(doc.indexOf('"id": "f"')).toBeLessThan(doc.indexOf('"parameter"'));
    // open layout config key-sorted.
    expect(doc.indexOf('"a": 2')).toBeLessThan(doc.indexOf('"z": 1'));
  });
});
