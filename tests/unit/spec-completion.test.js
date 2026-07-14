import { describe, expect, it, vi } from 'vitest';
import { completeSpec } from '../../src/core/spec-completion.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';

const complete = (request) => completeSpec({ schemaService: querySpecSchemaService, ...request });
const labels = (request) => complete(request).map((item) => item.label);

describe('schema-aware Spec completion', () => {
  it('offers ordered root properties, omits existing keys, and inserts JSON pairs', () => {
    const items = complete({ rootValue: { name: 'Q' }, path: [], positionKind: 'property-name', existingKeys: ['name'] });
    expect(items.map((item) => item.label)).toEqual(['description', 'favorite', 'view', 'panel', 'dashboard']);
    expect(items.find((item) => item.label === 'favorite').apply).toBe('"favorite": false');
    expect(items.find((item) => item.label === 'panel').apply).toBe('"panel": {"cfg":{"type":""}}');
  });

  it('narrows cfg properties to an implemented discriminator branch', () => {
    expect(labels({ rootValue: { panel: { cfg: { type: 'logs' } } }, path: ['panel', 'cfg'], positionKind: 'property-name', existingKeys: ['type'] }))
      .toEqual(['time', 'msg', 'level']);
    expect(labels({ rootValue: { panel: { cfg: {} } }, path: ['panel', 'cfg'], positionKind: 'property-name', existingKeys: [] }))
      .toContain('type');
  });

  it('offers exactly the implemented panel types with schema-owned metadata', () => {
    const items = complete({ rootValue: { panel: { cfg: {} } }, path: ['panel', 'cfg', 'type'], positionKind: 'property-value' });
    expect(items.map((item) => item.label)).toEqual(['bar', 'hbar', 'line', 'area', 'pie', 'table', 'logs', 'text']);
    expect(items.find((item) => item.label === 'logs')).toMatchObject({ detail: 'Logs', documentation: expect.stringContaining('Timestamped') });
  });

  it('completes enum, primitive, defaults, and preserves valid JSON literals', () => {
    const view = complete({ rootValue: {}, path: ['view'], positionKind: 'property-value' });
    expect(view.map((item) => item.apply)).toEqual(expect.arrayContaining(['"table"', '"json"', '"panel"']));
    expect(view.find((item) => item.apply === '"table"')).toMatchObject({ boost: expect.any(Number) });
    const favorite = complete({ rootValue: {}, path: ['favorite'], positionKind: 'property-value' });
    expect(favorite.map((item) => item.apply)).toEqual(expect.arrayContaining(['true', 'false']));
    const series = complete({ rootValue: { panel: { cfg: { type: 'line' } } }, path: ['panel', 'cfg', 'series'], positionKind: 'property-value' });
    expect(series.map((item) => item.apply)).toContain('null');
  });

  it('uses dynamic result columns for values, indexes, and object keys without side effects', () => {
    const dynamicSources = {
      resultColumns: vi.fn(() => [{ value: 'requests', detail: 'UInt64' }]),
      resultColumnIndexes: vi.fn(() => [{ value: 1, label: '1', detail: 'requests · UInt64' }]),
    };
    expect(complete({ rootValue: { panel: { cfg: { type: 'logs' } } }, path: ['panel', 'cfg', 'msg'], positionKind: 'property-value', dynamicSources }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'requests', apply: '"requests"', detail: 'UInt64' })]));
    expect(complete({ rootValue: { panel: { cfg: { type: 'line', y: [] } } }, path: ['panel', 'cfg', 'x'], positionKind: 'property-value', dynamicSources }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: '1', apply: '1' })]));
    expect(complete({ rootValue: { panel: { fieldConfig: { columns: {} } } }, path: ['panel', 'fieldConfig', 'columns'], positionKind: 'property-name', dynamicSources }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'requests', apply: '"requests": {}' })]));
    expect(dynamicSources.resultColumns).toHaveBeenCalled();
  });

  it('filters partials, suppresses configured dynamic keys, and fails soft for a throwing source', () => {
    const source = vi.fn(() => [{ value: 'requests' }, { value: 'errors' }]);
    const items = complete({
      rootValue: { panel: { fieldConfig: { columns: { requests: {} } } } }, path: ['panel', 'fieldConfig', 'columns'],
      positionKind: 'property-name', partial: 'err', existingKeys: ['requests'], dynamicSources: { resultColumns: source },
    });
    expect(items.map((item) => item.label)).toEqual(['errors']);
    expect(complete({ rootValue: { panel: { cfg: { type: 'logs' } } }, path: ['panel', 'cfg', 'msg'], positionKind: 'property-value', dynamicSources: { resultColumns: () => { throw new Error('offline'); } } }))
      .toEqual([]);
  });

  it('returns nothing without a schema service or completion position', () => {
    expect(completeSpec({})).toEqual([]);
  });

  it('normalizes every schema annotation shape through the injected service', () => {
    const service = {
      schemaAtPath: vi.fn(() => ({ common: {}, candidates: [{
        type: ['object', 'array', 'boolean', 'null'], const: 'fixed', enum: ['one'], default: false,
        examples: ['sample'], title: 'Synthetic', description: 'Synthetic documentation',
        'x-altinity-snippet': { example: true }, 'x-altinity-completion': { source: 'queryParameters' },
      }] })),
      propertiesAtPath: vi.fn(() => [{ name: 'fallback', required: true, schemas: [{}] }, {
        name: 'deprecated', required: false, schemas: [{ type: 'string', 'x-altinity-deprecated': true }],
      }]),
    };
    const dynamicSources = { queryParameters: () => [{ label: 'p', type: 'parameter', documentation: 'Parameter docs', boost: 2 }] };
    const values = completeSpec({ schemaService: service, rootValue: {}, path: ['value'], positionKind: 'property-value', dynamicSources });
    expect(values.map((item) => item.label)).toEqual(expect.arrayContaining(['fixed', 'one', 'true', 'false', 'null', 'sample', 'Synthetic', '[]', 'p']));
    const properties = completeSpec({ schemaService: service, rootValue: {}, path: [], positionKind: 'property-name', existingKeys: [] });
    expect(properties.find((item) => item.label === 'fallback')).toMatchObject({ apply: '"fallback": null', boost: 100 });
    expect(properties.find((item) => item.label === 'deprecated')).toMatchObject({ deprecated: true, apply: '"deprecated": ""' });
  });

  it('handles incomplete schema envelopes and fallback dynamic candidate forms', () => {
    const service = {
      schemaAtPath: vi.fn(({ path }) => (path.at(-1) === 'type'
        ? { candidates: [{}, { properties: { type: { const: 'planned' } }, 'x-altinity-status': 'planned' }] }
        : { candidates: [{ type: 'object', 'x-altinity-snippet': { a: 1 } }] })),
      propertiesAtPath: vi.fn(() => [{ name: 'thing', required: false, schemas: [{ type: 'object', 'x-altinity-snippet': { a: 1 } }] }]),
    };
    expect(completeSpec({ schemaService: service, rootValue: {}, path: ['value'], positionKind: 'property-value' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Object', type: 'object' })]));
    const keyService = { ...service, schemaAtPath: vi.fn(() => ({ common: { 'x-altinity-key-completion': { source: 'resultColumns' } }, candidates: [] })) };
    expect(completeSpec({ schemaService: keyService, rootValue: {}, path: [], positionKind: 'property-name', dynamicSources: { resultColumns: () => [{ label: 'raw' }] } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'raw', type: 'column', apply: '"raw": {}' })]));
  });
});
