import { describe, expect, it, vi } from 'vitest';
import { completeSpec } from '../../src/core/spec-completion.js';
import {
  createSpecSchemaService, querySpecSchemaService,
} from '../../src/core/spec-schema.js';

const complete = (over = {}) => completeSpec({
  schemaService: querySpecSchemaService,
  rootValue: {}, path: [], positionKind: 'property-name', partial: '',
  existingKeys: [], existingItems: [], explicit: true,
  dynamicSources: {}, context: {}, ...over,
});

describe('pure Spec completion', () => {
  it('offers canonical root keys in order, filters prefixes, and omits existing keys', () => {
    expect(complete().map((item) => item.label)).toEqual([
      'name', 'description', 'favorite', 'view', 'panel', 'dashboard',
    ]);
    expect(complete({ partial: 'pa' }).map((item) => item.label)).toEqual(['panel']);
    expect(complete({ existingKeys: ['name', 'panel'] }).map((item) => item.label))
      .toEqual(['description', 'favorite', 'view', 'dashboard']);
  });

  it('keeps unresolved discriminator keys quiet and selects branch-specific keys from siblings', () => {
    expect(complete({
      rootValue: { panel: { cfg: {} } }, path: ['panel', 'cfg'],
    }).map((item) => item.label)).toEqual(['type']);
    expect(complete({
      rootValue: { panel: { cfg: { type: 'line' } } }, path: ['panel', 'cfg'],
    }).map((item) => item.label)).toEqual(['type', 'x', 'y', 'series']);
    expect(complete({
      rootValue: { panel: { cfg: { type: 'logs' } } }, path: ['panel', 'cfg'],
    }).map((item) => item.label)).toEqual(['type', 'time', 'msg', 'level']);
  });

  it('derives every finite variant and never leaks the generic fallback snippet', () => {
    const items = complete({
      rootValue: { panel: { cfg: {} } }, path: ['panel', 'cfg', 'type'],
      positionKind: 'property-value',
    });
    expect(items.filter((item) => item.kind === 'variant').map((item) => item.label)).toEqual([
      'bar', 'hbar', 'line', 'area', 'pie', 'table', 'logs', 'text',
    ]);
    expect(items.map((item) => item.label)).not.toContain('future-panel');
    expect(items.find((item) => item.label === 'line').documentation).toContain('Line series');
  });

  it('discovers a synthetic future branch and ranks planned/deprecated variants last', () => {
    const schema = {
      type: 'object', properties: { cfg: {
        type: 'object', 'x-altinity-discriminator': 'kind', properties: { kind: { type: 'string' } },
        oneOf: [
          { title: 'Current', properties: { kind: { const: 'current' } } },
          { title: 'Next', 'x-altinity-status': 'planned', properties: { kind: { const: 'next' } } },
          { title: 'Old', 'x-altinity-deprecated': true, properties: { kind: { enum: ['old'] } } },
          { properties: { kind: { type: 'string', not: { enum: ['current', 'next', 'old'] } } } },
        ],
      } },
    };
    const service = createSpecSchemaService({ schema, validateCompiled: () => true });
    expect(complete({
      schemaService: service, rootValue: { cfg: {} }, path: ['cfg', 'kind'], positionKind: 'property-value',
    }).map((item) => [item.label, item.status, item.deprecated])).toEqual([
      ['current', undefined, false], ['next', 'planned', false], ['old', undefined, true],
    ]);
  });

  it('completes enum, boolean, nullable, default, example, object, and array values as JSON', () => {
    expect(complete({ path: ['view'], positionKind: 'property-value' }).map((item) => item.insert))
      .toEqual(['"table"', '"json"', '"panel"']);
    const favorite = complete({ path: ['favorite'], positionKind: 'property-value' });
    expect(favorite.map((item) => item.insert)).toEqual(['true', 'false']);
    expect(favorite.find((item) => item.insert === 'false').documentation).toContain('Default: false');
    expect(complete({ path: ['name'], positionKind: 'property-value' }).map((item) => item.insert))
      .toEqual(['"Revenue by country"']);
    expect(complete({ path: ['panel'], positionKind: 'property-value' })[0].insert).toBe('{}');
    expect(complete({
      rootValue: { panel: { cfg: { type: 'line' } } }, path: ['panel', 'cfg', 'y'], positionKind: 'property-value',
    }).some((item) => item.insert === '[]')).toBe(true);
    expect(complete({
      rootValue: { panel: { fieldConfig: { defaults: {} } } },
      path: ['panel', 'fieldConfig', 'defaults'], positionKind: 'property-name',
    }).find((item) => item.label === 'decimals').apply.value).toBe('0');
  });

  it('composes annotated dynamic columns and indexes without diagnostics or duplicates', () => {
    const resultColumns = vi.fn(() => [
      { label: 'event_time', value: 'event_time', kind: 'column', detail: 'DateTime' },
      { label: 'requests', value: 'requests', kind: 'column', detail: 'UInt64' },
    ]);
    const resultColumnIndexes = vi.fn(() => [
      { label: '0', value: 0, kind: 'column-index', detail: 'event_time · DateTime' },
      { label: '1', value: 1, kind: 'column-index', detail: 'requests · UInt64' },
    ]);
    const sources = { resultColumns, resultColumnIndexes };
    const logs = { panel: { cfg: { type: 'logs' } } };
    expect(complete({
      rootValue: logs, path: ['panel', 'cfg', 'time'], positionKind: 'property-value', dynamicSources: sources,
    }).map((item) => [item.label, item.insert])).toEqual([
      ['event_time', '"event_time"'], ['requests', '"requests"'],
    ]);
    const chart = { panel: { cfg: { type: 'line', y: [0] } } };
    expect(complete({
      rootValue: chart, path: ['panel', 'cfg', 'y', 1], positionKind: 'array-item',
      existingItems: [0], dynamicSources: sources,
    }).map((item) => [item.label, item.insert])).toEqual([['1', '1']]);
    expect(resultColumns).toHaveBeenCalledTimes(1);
    expect(resultColumnIndexes).toHaveBeenCalledTimes(1);
    expect(complete({
      rootValue: logs, path: ['panel', 'cfg', 'time'], positionKind: 'property-value', dynamicSources: {},
    })).toEqual([]);
  });

  it('completes annotated dynamic object keys with schema-derived value skeletons', () => {
    const rootValue = { panel: { fieldConfig: { columns: { requests: {} } } } };
    const items = complete({
      rootValue, path: ['panel', 'fieldConfig', 'columns'], existingKeys: ['requests'],
      dynamicSources: { resultColumns: () => [
        { label: 'requests', value: 'requests', kind: 'column' },
        { label: 'latency.p95', value: 'latency.p95', kind: 'column' },
      ] },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: 'latency.p95', apply: { type: 'property', name: 'latency.p95', value: '{}' },
    });
  });

  it('offers schema snippets only for a safe whole-object replacement', () => {
    const base = {
      rootValue: { panel: { cfg: {} } }, path: ['panel', 'cfg', 'type'], positionKind: 'property-value',
    };
    expect(complete(base).some((item) => item.kind === 'snippet')).toBe(false);
    const items = complete({
      ...base, context: {
        objectIsSingleProperty: true, objectClosed: true, objectRange: { from: 10, to: 25 },
      },
    });
    expect(items.find((item) => item.label === 'Line chart skeleton')).toMatchObject({
      kind: 'snippet', apply: { type: 'object-snippet', value: { type: 'line', x: 0, y: [1], series: null } },
    });
  });

  it('returns no candidates for unknown positions, sources, or unrelated prefixes', () => {
    expect(complete({ positionKind: 'none' })).toEqual([]);
    expect(complete({ path: ['unknown'], positionKind: 'property-value' })).toEqual([]);
    expect(complete({ path: ['view'], positionKind: 'property-value', partial: 'zzz' })).toEqual([]);
    expect(complete({ schemaService: null })).toEqual([]);
  });

  it('normalizes synthetic edge schemas and dynamic providers deterministically', () => {
    const schema = {
      type: 'object', properties: {
        unknown: {}, number: { type: 'number' }, numberExample: { type: 'number', examples: [1.5] },
        union: { type: ['string', 'null'] },
        nullConst: { const: null }, arrayConst: { const: [1] }, plain: { type: 'string' },
        duplicate: { type: 'string', const: 'x', enum: ['x', 'y'] },
        ranked: { type: 'string', enum: ['p', 'panel', 'pie'] },
        dynamic: { type: 'string', 'x-altinity-completion': { source: 'edge' } },
      },
    };
    const service = createSpecSchemaService({ schema, validateCompiled: () => true });
    const properties = complete({ schemaService: service });
    expect(properties.find((item) => item.label === 'unknown')).toMatchObject({
      detail: 'JSON value', apply: { value: '{}' },
    });
    expect(properties.find((item) => item.label === 'number')).toBeUndefined();
    expect(properties.find((item) => item.label === 'numberExample').apply.value).toBe('1.5');
    expect(properties.find((item) => item.label === 'union').apply.value).toBe('""');
    expect(complete({ schemaService: service, path: ['nullConst'], positionKind: 'property-value' })[0].insert).toBe('null');
    expect(complete({ schemaService: service, path: ['arrayConst'], positionKind: 'property-value' })[0].insert).toBe('[1]');
    expect(complete({ schemaService: service, path: ['plain'], positionKind: 'property-value' })[0].insert).toBe('""');
    expect(complete({ schemaService: service, path: ['duplicate'], positionKind: 'property-value' })
      .map((item) => item.insert)).toEqual(['"x"', '"y"']);
    expect(complete({
      schemaService: service, path: ['dynamic'], positionKind: 'property-value',
      dynamicSources: { edge: () => [{ value: 'fallback' }] },
    })[0]).toMatchObject({ label: 'fallback', insert: '"fallback"', kind: 'string' });
    expect(complete({
      schemaService: service, path: ['dynamic'], positionKind: 'property-value',
      dynamicSources: { edge: () => [{ label: 'label-only' }] },
    })[0]).toMatchObject({ label: 'label-only', insert: '"label-only"', value: 'label-only' });
    expect(complete({
      schemaService: service, path: ['dynamic'], positionKind: 'property-value',
      dynamicSources: { edge: () => undefined },
    })).toEqual([]);
    expect(complete({
      schemaService: service, path: ['ranked'], positionKind: 'property-value', partial: 'p',
    }).map((item) => item.label)).toEqual(['p', 'panel', 'pie']);
    expect(complete({ partial: 'panel' }).map((item) => item.label)).toEqual(['panel']);
  });
});
