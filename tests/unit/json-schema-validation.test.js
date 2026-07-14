import { describe, expect, it } from 'vitest';
import {
  JSON_SCHEMA_KEYWORD_CODES, createJsonSchemaValidationService, formatJsonPath,
  normalizeJsonSchemaErrors, pathFromJsonPointer, pointerSegments,
} from '../../src/core/json-schema-validation.js';

describe('JSON Schema diagnostic normalization', () => {
  it('decodes pointers and preserves array indexes, dotted keys, and escaped segments', () => {
    const root = { queries: [{ spec: { 'latency.p95': { 'a/b~c': 1 } } }] };
    expect(pointerSegments('/queries/0/spec/latency.p95/a~1b~0c')).toEqual([
      'queries', '0', 'spec', 'latency.p95', 'a/b~c',
    ]);
    expect(pathFromJsonPointer(root, '/queries/0/spec/latency.p95/a~1b~0c')).toEqual([
      'queries', 0, 'spec', 'latency.p95', 'a/b~c',
    ]);
    expect(formatJsonPath([])).toBe('Document');
    expect(formatJsonPath([], 'Spec')).toBe('Spec');
    expect(formatJsonPath(['queries', 0, 'spec', 'latency.p95'])).toBe('queries[0].spec["latency.p95"]');
  });

  it('maps keywords to stable codes, messages, child paths, and schema identities', () => {
    const root = { list: ['x'], object: { extra: true } };
    const cases = [
      ['type', '/list/0', { type: 'integer' }, 'schema-invalid-type', 'list[0] must be integer'],
      ['required', '/object', { missingProperty: 'name' }, 'schema-required', 'object.name is required'],
      ['const', '/list/0', { allowedValue: 1 }, 'schema-invalid-constant', 'list[0] must equal 1'],
      ['enum', '/list/0', { allowedValues: ['a', 'b'] }, 'schema-invalid-enum', 'list[0] must be one of "a", "b"'],
      ['minimum', '/list/0', { limit: 1 }, 'schema-number-range', 'list[0] must be at least 1'],
      ['maximum', '/list/0', { limit: 2 }, 'schema-number-range', 'list[0] must be at most 2'],
      ['exclusiveMinimum', '/list/0', { limit: 1 }, 'schema-number-range', 'list[0] must be greater than 1'],
      ['exclusiveMaximum', '/list/0', { limit: 2 }, 'schema-number-range', 'list[0] must be less than 2'],
      ['minLength', '/list/0', { limit: 1 }, 'schema-invalid-string', 'list[0] must contain at least 1 character'],
      ['maxLength', '/list/0', { limit: 2 }, 'schema-invalid-string', 'list[0] must contain at most 2 characters'],
      ['pattern', '/list/0', {}, 'schema-invalid-string', 'list[0] has an invalid string value'],
      ['minItems', '/list', { limit: 1 }, 'schema-array-size', 'list must contain at least 1 item'],
      ['maxItems', '/list', { limit: 2 }, 'schema-array-size', 'list must contain at most 2 items'],
      ['uniqueItems', '/list', { i: 0 }, 'schema-array-duplicate', 'list[0] must not contain duplicate items'],
      ['anyOf', '/list/0', {}, 'schema-invalid-variant', 'list[0] must match an allowed variant'],
      ['additionalProperties', '/object', { additionalProperty: 'extra' }, 'schema-unknown-property', 'object.extra is not an allowed property'],
      ['unevaluatedProperties', '/object', { unevaluatedProperty: 'extra' }, 'schema-unknown-property', 'object.extra is not an allowed property'],
      ['format', '/list/0', { format: 'date-time' }, 'schema-invalid-format', 'list[0] must match format "date-time"'],
      ['$ref', '/list/0', {}, 'schema-internal-reference', 'list[0] contains an unresolved schema reference'],
      ['custom', '/list/0', {}, 'schema-custom', 'list[0] failed custom validation'],
    ];
    for (const [keyword, instancePath, params, code, message] of cases) {
      const [item] = normalizeJsonSchemaErrors({
        root,
        schemaId: 'https://example.test/root',
        errors: [{ keyword, instancePath, params, message: 'failed custom validation', schemaPath: '#/x' }],
      });
      expect(item).toMatchObject({ code, message, keyword, schemaId: 'https://example.test/root' });
    }
    const [referenced] = normalizeJsonSchemaErrors({
      root, schemaId: 'fallback',
      errors: [{ keyword: 'type', instancePath: '/list/0', params: { type: ['integer', 'null'] },
        schemaPath: 'https://example.test/child#/type' }],
    });
    expect(referenced.message).toContain('integer or null');
    expect(referenced.schemaId).toBe('https://example.test/child');
  });

  it('removes union noise, same-path non-type noise, duplicates, and sorts paths', () => {
    const errors = [
      { keyword: 'oneOf', instancePath: '/a', params: {}, schemaPath: '#/oneOf' },
      { keyword: 'const', instancePath: '/a/type', params: { allowedValue: 'x' }, schemaPath: '#/const' },
      { keyword: 'required', instancePath: '/a', params: { missingProperty: 'x' }, schemaPath: '#/required' },
      { keyword: 'minimum', instancePath: '/z', params: { limit: 1 }, schemaPath: '#/min' },
      { keyword: 'type', instancePath: '/z', params: { type: 'integer' }, schemaPath: '#/type' },
      { keyword: 'type', instancePath: '/z', params: { type: 'integer' }, schemaPath: '#/type' },
    ];
    const out = normalizeJsonSchemaErrors({ root: { a: {}, z: 'x' }, errors });
    expect(out).toEqual([
      expect.objectContaining({ path: ['a', 'x'], code: 'schema-required' }),
      expect.objectContaining({ path: ['z'], code: 'schema-invalid-type' }),
    ]);
  });

  it('retains a concise scalar oneOf and supports custom code mappings/formatters', () => {
    const out = normalizeJsonSchemaErrors({
      root: { value: true },
      keywordCodes: { oneOf: 'custom-variant' },
      formatPath: (path) => 'ROOT/' + path.join('/'),
      errors: [
        { keyword: 'oneOf', instancePath: '/value', params: {}, schemaPath: '#/oneOf' },
        { keyword: 'type', instancePath: '/value', params: { type: 'string' }, schemaPath: '#/oneOf/0' },
      ],
    });
    expect(out[0]).toMatchObject({ code: 'custom-variant', message: 'ROOT/value must match exactly one allowed variant' });
    expect(JSON_SCHEMA_KEYWORD_CODES.not).toBe('schema-invalid-variant');
  });
});

describe('JSON Schema validation registry', () => {
  it('looks up schemas, validates values, and rejects bad configuration/ids', () => {
    const validator = (value) => {
      validator.errors = value === 1 ? null : [{ keyword: 'const', instancePath: '', params: { allowedValue: 1 } }];
      return value === 1;
    };
    const service = createJsonSchemaValidationService({ schemasById: { one: { $id: 'one' } }, validatorsById: { one: validator } });
    expect(service.getSchema('one')).toEqual({ $id: 'one' });
    expect(service.validate('one', 1)).toEqual([]);
    expect(service.validate('one', 2)[0]).toMatchObject({ path: [], code: 'schema-invalid-constant' });
    expect(() => service.validate('missing', 1)).toThrow('Unknown JSON Schema');
    expect(() => createJsonSchemaValidationService()).toThrow('Schema and validator registries are required');
  });
});
