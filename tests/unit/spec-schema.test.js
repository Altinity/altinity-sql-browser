import { describe, expect, it, vi } from 'vitest';
import { querySpecV1Schema as querySpecSchema } from '../../src/generated/json-schemas.js';
import {
  createQuerySpecValidationService, createSpecSchemaService,
  createSpecValidationService, formatSpecPath, querySpecSchemaService,
} from '../../src/core/spec-schema.js';

const panels = [
  { type: 'bar', x: 0, y: [1], series: null },
  { type: 'hbar', x: 0, y: [1, 2], series: 3 },
  { type: 'line', x: 0, y: [1], series: null },
  { type: 'area', x: 0, y: [1], series: null },
  { type: 'pie', x: 0, y: [1], series: null },
  { type: 'table' },
  { type: 'logs', time: 'event_time', msg: 'message', level: 'level' },
  { type: 'text' },
  { type: 'text', content: '# Safe' },
];

describe('canonical query.spec schema', () => {
  it('has the stable v1 identity and accepts the implemented baseline plus extensions', () => {
    expect(querySpecSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(querySpecSchema.$id).toBe('https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json');
    expect(querySpecSchema.title).toBe('Altinity SQL Browser saved-query Spec v1');
    expect(querySpecSchemaService.validate({})).toEqual([]);
    for (const cfg of panels) {
      expect(querySpecSchemaService.validate({
        name: 'Q', description: 'D', favorite: true, view: 'panel',
        panel: {
          cfg, key: null,
          fieldConfig: {
            defaults: { displayName: 'Default', decimals: 2, future: true },
            columns: { latency: { displayName: 'Latency', decimals: 1, extension: [1] } },
            extension: {},
          },
          extension: { nested: true },
        },
        dashboard: { role: 'panel', layout: { x: 1 } },
        extension: { any: ['json'] },
      })).toEqual([]);
    }
    expect(querySpecSchemaService.validate({ panel: { cfg: { type: 'future-gauge', custom: true } } })).toEqual([]);
  });

  it('enforces known root, field, dashboard, and panel shapes without rejecting unknown fields', () => {
    const diagnostics = querySpecSchemaService.validate({
      name: ' ', description: 1, favorite: 'yes', view: 'raw',
      panel: {
        key: 1,
        fieldConfig: { columns: { 'latency.p95': { displayName: 2, decimals: '2' } } },
        cfg: { type: 'logs', time: '', msg: 1, level: null, unknown: 'kept' },
      },
      dashboard: { role: 'unknown', future: true },
    });
    expect(diagnostics.map((item) => [item.path, item.code])).toEqual([
      [['dashboard', 'role'], 'schema-invalid-enum'],
      [['description'], 'schema-invalid-type'],
      [['favorite'], 'schema-invalid-type'],
      [['name'], 'schema-invalid-string'],
      [['panel', 'cfg', 'level'], 'schema-invalid-type'],
      [['panel', 'cfg', 'msg'], 'schema-invalid-type'],
      [['panel', 'cfg', 'time'], 'schema-invalid-string'],
      [['panel', 'fieldConfig', 'columns', 'latency.p95', 'decimals'], 'schema-invalid-type'],
      [['panel', 'fieldConfig', 'columns', 'latency.p95', 'displayName'], 'schema-invalid-type'],
      [['panel', 'key'], 'schema-invalid-type'],
      [['view'], 'schema-invalid-enum'],
    ]);
    expect(querySpecSchemaService.validate([])[0]).toMatchObject({ path: [], code: 'schema-invalid-type' });
  });

  it('enforces chart index arrays, Pie cardinality, and missing discriminators concisely', () => {
    expect(querySpecSchemaService.validate({ panel: { cfg: {} } })).toEqual([{
      path: ['panel', 'cfg', 'type'], severity: 'error', code: 'schema-required',
      message: 'panel.cfg.type is required', keyword: 'required',
      schemaId: 'https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json',
    }]);
    expect(querySpecSchemaService.validate({ panel: { cfg: { type: 'line', x: -1, y: [] } } })
      .map((item) => [item.path, item.code])).toEqual([
      [['panel', 'cfg', 'x'], 'schema-number-range'],
      [['panel', 'cfg', 'y'], 'schema-array-size'],
    ]);
    expect(querySpecSchemaService.validate({ panel: { cfg: { type: 'bar', x: 0, y: [1, 1] } } })[0])
      .toMatchObject({ path: ['panel', 'cfg', 'y', 1], code: 'schema-array-duplicate' });
    expect(querySpecSchemaService.validate({ panel: { cfg: { type: 'pie', x: 0, y: [1, 2] } } })[0])
      .toMatchObject({ path: ['panel', 'cfg', 'y'], code: 'schema-array-size' });
    expect(querySpecSchemaService.validate({ panel: { cfg: { type: 'line', x: 0, y: [1], series: 'bad' } } })[0])
      .toMatchObject({ path: ['panel', 'cfg', 'series'], code: 'schema-invalid-variant' });
    expect(querySpecSchemaService.validate({ panel: { cfg: { type: 'text', content: 1 } } })[0])
      .toMatchObject({ path: ['panel', 'cfg', 'content'], code: 'schema-invalid-type' });
  });
});

describe('schema lookup', () => {
  it('selects a discriminated branch and exposes ordered properties and annotations', () => {
    const root = { panel: { cfg: { type: 'logs', time: 'event_time' } } };
    const properties = querySpecSchemaService.propertiesAtPath({ root, path: ['panel', 'cfg'] });
    expect(properties.map((item) => item.name)).toEqual(['type', 'time', 'msg', 'level']);
    expect(properties[0].required).toBe(true);
    expect(properties[0].schemas[0]).toMatchObject({
      title: 'Panel type', type: 'string', minLength: 1, const: 'logs',
    });
    expect(properties[1].required).toBe(false);
    expect(properties[1].schemas[0]['x-altinity-completion']).toEqual({ source: 'resultColumns' });
    const annotations = querySpecSchemaService.annotationsAtPath({ root, path: ['panel', 'cfg'] });
    expect(annotations.common).toMatchObject({
      title: 'Logs', 'x-altinity-status': 'implemented',
      'x-altinity-snippet': { type: 'logs', time: 'event_time', msg: 'message', level: 'level' },
    });
    expect(annotations.candidates).toHaveLength(1);
  });

  it('retains ordered candidates while a discriminator is incomplete', () => {
    const root = { panel: { cfg: {} } };
    const schema = querySpecSchemaService.schemaAtPath({ root, path: ['panel', 'cfg'] });
    expect(schema.candidates).toHaveLength(9);
    expect(schema.common['x-altinity-discriminator']).toBe('type');
    const typeProperty = querySpecSchemaService.propertiesAtPath({ root, path: ['panel', 'cfg'] })[0];
    expect(typeProperty.name).toBe('type');
    expect(typeProperty.schemas).toHaveLength(9);
    expect(typeProperty.schemas.every((candidate) => candidate.title === 'Panel type'
      && candidate.type === 'string' && candidate.minLength === 1)).toBe(true);
    const unknown = querySpecSchemaService.annotationsAtPath({
      root: { panel: { cfg: { type: 'brand-new' } } }, path: ['panel', 'cfg'],
    });
    expect(unknown.candidates).toEqual([expect.objectContaining({ 'x-altinity-status': 'planned' })]);
  });

  it('resolves nested refs, array items, and dynamic dotted object keys', () => {
    const chart = { panel: { cfg: { type: 'line', x: 0, y: [1] } } };
    expect(querySpecSchemaService.schemaAtPath({ root: chart, path: ['panel', 'cfg', 'x'] }).common)
      .toMatchObject({ type: 'integer', minimum: 0, 'x-altinity-completion': { source: 'resultColumnIndexes' } });
    expect(querySpecSchemaService.schemaAtPath({ root: chart, path: ['panel', 'cfg', 'y', 0] }).common)
      .toMatchObject({ type: 'integer', minimum: 0, 'x-altinity-completion': { source: 'resultColumnIndexes' } });
    const fields = { panel: { fieldConfig: { columns: { 'latency.p95': { decimals: 2 } } } } };
    expect(querySpecSchemaService.schemaAtPath({
      root: fields, path: ['panel', 'fieldConfig', 'columns', 'latency.p95', 'decimals'],
    }).common).toMatchObject({ type: 'integer', title: 'Decimal places' });
    expect(querySpecSchemaService.schemaAtPath({ root: {}, path: ['missing'] }))
      .toEqual({ common: {}, candidates: [] });
  });

  it('supports the documented lookup subset on synthetic schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        tuple: { type: 'array', prefixItems: [{ const: 'head' }], items: { type: 'number' } },
        choice: {
          anyOf: [
            { properties: { kind: { const: 'a' }, a: { type: 'string' } } },
            { properties: { kind: { const: 'b' }, b: { type: 'number' } } },
          ],
          'x-altinity-discriminator': 'kind',
        },
        conditional: {
          if: { required: ['enabled'], properties: { enabled: { const: true } } },
          then: { properties: { on: { type: 'string' } } },
          else: { properties: { off: { type: 'string' } } },
        },
        map: { patternProperties: { '^x-': { $ref: '#/$defs/value', title: 'Pattern value' } }, additionalProperties: { type: 'boolean' } },
        mergedMap: {
          allOf: [
            { patternProperties: { '^a': { type: 'string' } } },
            { patternProperties: { '^b': { type: 'number' } } },
          ],
        },
        nullCheck: { if: { type: 'null' }, then: { properties: { yes: { type: 'string' } } }, else: { properties: { no: { type: 'string' } } } },
        arrayCheck: { if: { type: 'array' }, then: { properties: { yes: { type: 'string' } } }, else: { properties: { no: { type: 'string' } } } },
        objectCheck: { if: { type: 'object' }, then: { properties: { yes: { type: 'string' } } }, else: { properties: { no: { type: 'string' } } } },
        integerCheck: { if: { type: 'integer' }, then: { properties: { yes: { type: 'string' } } }, else: { properties: { no: { type: 'string' } } } },
        numberCheck: { if: { type: 'number' }, then: { properties: { yes: { type: 'string' } } }, else: { properties: { no: { type: 'string' } } } },
        stringCheck: { if: { type: 'string' }, then: { properties: { yes: { type: 'string' } } }, else: { properties: { no: { type: 'string' } } } },
        fixed: { type: 'array', prefixItems: [{ type: 'string' }] },
        primitiveMerge: { allOf: [false] },
        noBranch: { if: { const: true } },
        enumChoice: {
          anyOf: [
            { properties: { kind: { enum: ['a', 'b'] }, enumValue: { type: 'string' } } },
            { properties: { other: { type: 'string' } } },
          ],
          'x-altinity-discriminator': 'kind',
        },
        nestedHost: {
          properties: {
            child: {
              'x-altinity-discriminator': 'kind',
              anyOf: [
                { properties: { kind: { const: 'a' }, selectedA: { type: 'string' } } },
                { properties: { kind: { const: 'b' }, selectedB: { type: 'number' } } },
              ],
            },
          },
        },
      },
      $defs: { value: { type: ['integer', 'null'], minimum: 0 } },
    };
    const service = createSpecSchemaService({ schema, validateCompiled: () => true });
    schema.properties.choice.anyOf.push({ allOf: [{ properties: { extension: { type: 'boolean' } } }] });
    const root = {
      tuple: ['head', 2], choice: { kind: 'b', b: 1 }, conditional: { enabled: true },
      map: { 'x-a': 1, other: true }, mergedMap: { beta: 1 },
      nullCheck: null, arrayCheck: [], objectCheck: {}, integerCheck: 1,
      numberCheck: 1.5, stringCheck: 'x',
      fixed: ['x'], primitiveMerge: {}, noBranch: false, enumChoice: { kind: 'b' },
      nestedHost: { child: { kind: 'b', selectedB: 1 } },
    };
    expect(service.schemaAtPath({ root, path: ['tuple', 0] }).common.const).toBe('head');
    expect(service.schemaAtPath({ root, path: ['tuple', 1] }).common.type).toBe('number');
    expect(service.propertiesAtPath({ root, path: ['choice'] }).map((item) => item.name)).toEqual(['kind', 'b']);
    expect(service.propertiesAtPath({ root, path: ['conditional'] }).map((item) => item.name)).toEqual(['on']);
    root.conditional.enabled = false;
    expect(service.propertiesAtPath({ root, path: ['conditional'] }).map((item) => item.name)).toEqual(['off']);
    expect(service.schemaAtPath({ root, path: ['map', 'x-a'] }).common).toMatchObject({ type: ['integer', 'null'], minimum: 0, title: 'Pattern value' });
    expect(service.schemaAtPath({ root, path: ['map', 'other'] }).common.type).toBe('boolean');
    expect(service.schemaAtPath({ root, path: ['mergedMap', 'beta'] }).common.type).toBe('number');
    for (const name of ['nullCheck', 'arrayCheck', 'objectCheck', 'integerCheck', 'numberCheck', 'stringCheck']) {
      expect(service.propertiesAtPath({ root, path: [name] }).map((item) => item.name)).toEqual(['yes']);
    }
    expect(service.schemaAtPath({ root, path: ['fixed', 1] })).toEqual({ common: {}, candidates: [] });
    expect(service.schemaAtPath({ root, path: ['primitiveMerge'] }).candidates).toHaveLength(1);
    expect(service.propertiesAtPath({ root, path: ['noBranch'] })).toEqual([]);
    expect(service.propertiesAtPath({ root, path: ['enumChoice'] }).map((item) => item.name)).toEqual(['kind', 'enumValue']);
    const nestedChild = service.propertiesAtPath({ root, path: ['nestedHost'] })
      .find((item) => item.name === 'child');
    expect(nestedChild.schemas).toHaveLength(1);
    expect(nestedChild.schemas[0].properties).toHaveProperty('selectedB');
    expect(service.propertiesAtPath({ root: null }).length).toBeGreaterThan(0);
  });

  it('rejects invalid, remote, unresolved, and cyclic lookup schemas', () => {
    expect(() => createSpecSchemaService({ schema: null, validateCompiled: () => true })).toThrow('Spec schema must be an object');
    expect(() => createSpecSchemaService({ schema: {}, validateCompiled: null })).toThrow('Compiled Spec validator must be a function');
    const look = (schema) => createSpecSchemaService({ schema, validateCompiled: () => true })
      .schemaAtPath({ root: {}, path: ['x'] });
    expect(() => look({ properties: { x: { $ref: 'https://example.com/x' } } })).toThrow('Only local schema references');
    expect(() => look({ properties: { x: { $ref: '#/$defs/nope' } }, $defs: {} })).toThrow('Unresolved schema reference');
    expect(() => look({ properties: { x: { $ref: '#/$defs/a' } }, $defs: { a: { $ref: '#/$defs/a' } } })).toThrow('Cyclic schema reference');
    expect(() => look({ properties: { x: { $ref: '#/$defs/a' } }, $defs: { a: 1 } })).not.toThrow();
  });
});

describe('diagnostic normalization', () => {
  it('maps every stable keyword code and preserves exact pointer segments', () => {
    const compiled = vi.fn(() => false);
    compiled.errors = [
      ['type', '/items/0', { type: ['string', 'null'] }, ''],
      ['required', '/obj', { missingProperty: 'a.b' }, ''],
      ['const', '/v', { allowedValue: 'x' }, ''],
      ['enum', '/v', { allowedValues: ['x', 'y'] }, ''],
      ['enum', '/enum-default', {}, ''],
      ['minimum', '/n', { limit: 1 }, ''],
      ['maximum', '/n', { limit: 2 }, ''],
      ['exclusiveMinimum', '/n', { limit: 0 }, ''],
      ['exclusiveMaximum', '/n', { limit: 3 }, ''],
      ['minLength', '/s', { limit: 1 }, ''],
      ['minLength', '/s2', { limit: 2 }, ''],
      ['maxLength', '/s', { limit: 2 }, ''],
      ['pattern', '/s', {}, ''],
      ['minItems', '/items', { limit: 1 }, ''],
      ['minItems', '/items2', { limit: 2 }, ''],
      ['maxItems', '/items', { limit: 2 }, ''],
      ['uniqueItems', '/items', { i: 1 }, ''],
      ['anyOf', '/v', {}, ''],
      ['$ref', '/v', {}, ''],
      ['custom', '/v', {}, 'must be custom'],
      [undefined, '/missing/child', undefined, ''],
    ].map(([keyword, instancePath, params, message]) => ({ keyword, instancePath, params, message, schemaPath: '#' }));
    const service = createSpecSchemaService({ schema: {}, validateCompiled: compiled });
    const diagnostics = service.validate({ items: ['x', 'x'], obj: {}, v: 1, n: 1, s: '' });
    expect(diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'schema-invalid-type', 'schema-required', 'schema-invalid-constant', 'schema-invalid-enum',
      'schema-number-range', 'schema-invalid-string', 'schema-array-size', 'schema-array-duplicate',
      'schema-invalid-variant', 'schema-internal-reference', 'schema-custom',
    ]));
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: ['obj', 'a.b'], message: 'obj["a.b"] is required' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: ['items', 1], code: 'schema-array-duplicate' }));
  });

  it('formats friendly paths and accepts a successful compiled result', () => {
    expect(formatSpecPath()).toBe('Spec');
    expect(formatSpecPath(['panel', 'a.b', 2, '$ok'])).toBe('panel["a.b"][2].$ok');
    const service = createSpecSchemaService({ schema: {}, validateCompiled: () => true });
    expect(service.validate({})).toEqual([]);
  });

  it('prefers actionable child diagnostics over non-discriminated oneOf noise', () => {
    const compiled = vi.fn(() => false);
    compiled.errors = [
      { keyword: 'required', instancePath: '/value', schemaPath: '#/oneOf/0/required', params: { missingProperty: 'child' }, message: '' },
      { keyword: 'const', instancePath: '/value/kind', schemaPath: '#/oneOf/1/properties/kind/const', params: { allowedValue: 'b' }, message: '' },
      { keyword: 'oneOf', instancePath: '/value', schemaPath: '#/oneOf', params: {}, message: '' },
    ];
    const service = createSpecSchemaService({ schema: {}, validateCompiled: compiled });
    expect(service.validate({ value: {} })).toEqual([{
      path: ['value', 'child'], severity: 'error', code: 'schema-required',
      message: 'value.child is required', keyword: 'required',
    }]);
  });

  it('retains non-discriminated variant diagnostics and tolerates missing compiled errors', () => {
    const compiled = vi.fn(() => false);
    compiled.errors = [{
      keyword: 'oneOf', instancePath: '', schemaPath: '#/oneOf', params: {}, message: '',
    }];
    expect(createSpecSchemaService({ schema: { oneOf: [{ type: 'string' }, { type: 'number' }] }, validateCompiled: compiled })
      .validate(true)[0]).toMatchObject({ path: [], code: 'schema-invalid-variant' });
    compiled.errors = null;
    expect(createSpecSchemaService({ schema: {}, validateCompiled: compiled }).validate(true)).toEqual([]);
  });
});

describe('feature validation service', () => {
  it('runs registered validators with context and unregisters idempotently', () => {
    const registry = createQuerySpecValidationService();
    const validator = vi.fn(({ root, path, value, present, context }) => {
      expect(root.items[0].kind).toBe('bad');
      expect(path).toEqual(['items', 0, 'kind']);
      expect(value).toBe('bad');
      expect(present).toBe(true);
      expect(context.resultColumns).toEqual([{ name: 'x' }]);
      return { severity: 'warning', code: 'bad-kind', message: 'Try another kind' };
    });
    const unregister = registry.register(['items', 0, 'kind'], validator);
    expect(registry.validate({ items: [{ kind: 'bad' }] }, { resultColumns: [{ name: 'x' }] })).toEqual([{
      path: ['items', 0, 'kind'], severity: 'warning', code: 'bad-kind', message: 'Try another kind',
    }]);
    unregister(); unregister();
    expect(registry.validate({ items: [{ kind: 'bad' }] })).toEqual([]);
  });

  it('normalizes feature defaults and skips validators across blocking schema paths', () => {
    const schemaService = { schema: {}, validate: vi.fn(() => [{
      path: ['panel'], severity: 'error', code: 'bad-panel', message: 'bad',
    }]) };
    const skippedChild = vi.fn();
    const skippedParent = vi.fn();
    const service = createSpecValidationService({ schemaService, initial: [
      { path: ['panel', 'cfg'], validate: skippedChild },
      { path: [], validate: skippedParent },
      { path: ['other'], validate: ({ present }) => ({ path: ['elsewhere'], message: present ? 'present' : 123, keyword: 'feature' }) },
    ] });
    expect(service.validate({})).toEqual([
      { path: ['panel'], severity: 'error', code: 'bad-panel', message: 'bad' },
      { path: ['elsewhere'], severity: 'error', code: 'invalid-spec', message: '123', keyword: 'feature' },
    ]);
    expect(skippedChild).not.toHaveBeenCalled();
    expect(skippedParent).not.toHaveBeenCalled();
    expect(() => createSpecValidationService({ schemaService: null })).toThrow('Spec schema service is required');
  });
});
