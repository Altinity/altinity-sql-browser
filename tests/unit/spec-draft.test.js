import { describe, expect, it, vi } from 'vitest';
import {
  CORE_SPEC_VALIDATORS, createSpecValidatorRegistry, evaluateSpecText,
  formatSpecText, hasBlockingSpecErrors, normalizeSpec, parseSpecJson,
  serializeSpec, validateSpec,
} from '../../src/core/spec-draft.js';

const SPEC_SCHEMA_ID = 'https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json';

describe('Spec JSON parsing', () => {
  it('parses every JSON value and reports deterministic line/column syntax errors', () => {
    expect(parseSpecJson('{"a":[true,false,null,-1.5e+2,"x\\u0020y"]}').value)
      .toEqual({ a: [true, false, null, -150, 'x y'] });
    expect(parseSpecJson('{\n  "a": 1,\n}')).toEqual({
      value: null,
      diagnostic: expect.objectContaining({
        path: [], severity: 'error', code: 'invalid-json',
        message: 'Expected a property name', line: 3, column: 1,
      }),
    });
  });

  it.each([
    ['', 'Expected a JSON value'],
    ['{"a" 1}', "Expected ':' after property name"],
    ['{"a":1 "b":2}', "Expected ',' or '}'"],
    ['[1 2]', "Expected ',' or ']'"],
    ['[1,]', 'Unexpected token'],
    ['"bad\nstring"', 'Control character in string'],
    ['"bad\\q"', 'Invalid escape sequence'],
    ['"bad\\u0x00"', 'Invalid Unicode escape'],
    ['"bad\\', 'Unterminated escape sequence'],
    ['"bad', 'Unterminated string'],
    ['01', 'Unexpected content after JSON value'],
    ['1.', 'Expected digits after decimal point'],
    ['1e+', 'Expected exponent digits'],
    ['tru', 'Unexpected token'],
    ['{} nope', 'Unexpected content after JSON value'],
  ])('rejects %j with a concise diagnostic', (text, message) => {
    expect(parseSpecJson(text).diagnostic.message).toBe(message);
  });
});

describe('Spec semantic validation', () => {
  it('accepts known correct types and arbitrary extensions', () => {
    const spec = {
      name: 'Q', description: 'D', favorite: true, view: 'panel',
      panel: { cfg: { type: 'future' } }, dashboard: { role: 'panel', future: true },
      'key.with.dots': [{ anything: true }],
    };
    expect(validateSpec(spec)).toEqual([]);
    expect(CORE_SPEC_VALIDATORS).toHaveLength(1);
  });

  it('rejects a non-object root, wrong known types, and a blank name', () => {
    expect(validateSpec([])).toEqual([
      { path: [], severity: 'error', code: 'schema-invalid-type', message: 'Spec must be object', keyword: 'type',
        schemaId: SPEC_SCHEMA_ID },
    ]);
    const diagnostics = validateSpec({
      name: '  ', description: 1, favorite: 'yes', view: [], panel: null, dashboard: [],
    });
    expect(diagnostics.map((d) => [d.path, d.code])).toEqual([
      [['dashboard'], 'schema-invalid-type'],
      [['description'], 'schema-invalid-type'],
      [['favorite'], 'schema-invalid-type'],
      [['name'], 'schema-invalid-string'],
      [['panel'], 'schema-invalid-type'],
      [['view'], 'schema-invalid-type'],
    ]);
    expect(hasBlockingSpecErrors(diagnostics)).toBe(true);
    expect(hasBlockingSpecErrors([{ severity: 'warning' }])).toBe(false);
  });

  it('supports registered exact array paths and dotted property keys', () => {
    const registry = createSpecValidatorRegistry([]);
    const validate = vi.fn(({ value, path, root, present }) => {
      expect(root['a.b'][0].kind).toBe('bad');
      expect(path).toEqual(['a.b', 0, 'kind']);
      expect(present).toBe(true);
      return value === 'bad'
        ? { severity: 'warning', code: 'bad-kind', message: 'Try another kind' }
        : [];
    });
    const unregister = registry.register(['a.b', 0, 'kind'], validate);
    expect(registry.validate({ 'a.b': [{ kind: 'bad' }] })).toEqual([
      { path: ['a.b', 0, 'kind'], severity: 'warning', code: 'bad-kind', message: 'Try another kind' },
    ]);
    unregister();
    unregister();
    expect(registry.validate({ 'a.b': [{ kind: 'bad' }] })).toEqual([]);
  });

  it('normalizes validator defaults and missing paths deterministically', () => {
    const validators = [{ path: ['missing'], validate: (ctx) => {
      expect(ctx).toMatchObject({ present: false, value: undefined, path: ['missing'] });
      return { message: 123 };
    } }];
    expect(validateSpec({}, validators)).toEqual([
      { path: ['missing'], severity: 'error', code: 'invalid-spec', message: '123' },
    ]);
  });
});

describe('Spec draft evaluation/formatting', () => {
  it('runs semantic validation only after successful parsing', () => {
    expect(evaluateSpecText('{"favorite":"yes"}')).toEqual({
      parsed: { favorite: 'yes' },
      diagnostics: [{
        path: ['favorite'], severity: 'error', code: 'schema-invalid-type',
        message: 'favorite must be boolean', keyword: 'type', schemaId: SPEC_SCHEMA_ID,
      }],
    });
    expect(evaluateSpecText('{').parsed).toBeNull();
    expect(evaluateSpecText('{').diagnostics[0].code).toBe('invalid-json');
  });

  it('accepts an app-owned validator registry', () => {
    const registry = createSpecValidatorRegistry([]);
    registry.register(['items', 0, 'kind'], ({ value }) => value === 'ok' ? [] : [{ message: 'bad kind' }]);
    expect(evaluateSpecText('{"items":[{"kind":"bad"}]}', registry).diagnostics).toEqual([{
      path: ['items', 0, 'kind'], severity: 'error', code: 'invalid-spec', message: 'bad kind',
    }]);
  });

  it('formats valid JSON with two spaces without sorting and leaves invalid text unchanged', () => {
    expect(formatSpecText('{"z":1,"a":{"b":2}}')).toEqual({
      text: '{\n  "z": 1,\n  "a": {\n    "b": 2\n  }\n}', diagnostic: null,
    });
    expect(formatSpecText('{bad')).toEqual({
      text: '{bad', diagnostic: expect.objectContaining({ code: 'invalid-json' }),
    });
  });

  it('normalizes settled text fields while retaining extensions and property order', () => {
    const source = JSON.parse('{"z":1,"name":"  Query  ","description":"  ","__proto__":{"safe":true},"a":2}');
    const normalized = normalizeSpec(source);
    expect(normalized.name).toBe('Query');
    expect(normalized.description).toBeUndefined();
    expect(Object.hasOwn(normalized, '__proto__')).toBe(true);
    expect(Object.keys(normalized)).toEqual(['z', 'name', '__proto__', 'a']);
    expect(serializeSpec(normalized)).toContain('\n  "name": "Query"');
    expect(source.name).toBe('  Query  ');
  });
});
