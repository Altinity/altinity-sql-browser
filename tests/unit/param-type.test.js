import { describe, it, expect } from 'vitest';
import {
  parseParamType,
  typeLexKind,
  conflictingTypes,
  enumMembers,
  enumValues,
} from '../../src/core/param-type.js';

describe('parseParamType', () => {
  it('parses a bare scalar', () => {
    const t = parseParamType('String');
    expect(t.raw).toBe('String');
    expect(t.base).toBe('String');
    expect(t.inner).toBeNull();
    expect(t.nullable).toBe(false);
    expect(t.isArray).toBe(false);
    expect(t.elem).toBeNull();
    expect(t.node).toEqual({ kind: 'type', name: 'String', raw: 'String', args: [], members: null });
  });

  it('parses a parameterized scalar (args kept raw)', () => {
    const t = parseParamType('Decimal(10, 2)');
    expect(t.base).toBe('Decimal');
    expect(t.inner).toBe('10, 2');
    expect(t.isArray).toBe(false);
    expect(t.elem).toBeNull();
  });

  it('`.inner` is trimmed, same contract as the old regex-based parser', () => {
    expect(parseParamType('Decimal( 10, 2 )').inner).toBe('10, 2');
  });

  it('parses Array(T) with a parsed element type', () => {
    const t = parseParamType('Array(String)');
    expect(t.isArray).toBe(true);
    expect(t.elem.base).toBe('String');
    expect(t.raw).toBe('Array(String)');
  });

  it('unwraps Nullable(...) and flags it', () => {
    const t = parseParamType('Nullable(UInt64)');
    expect(t).toMatchObject({ raw: 'Nullable(UInt64)', base: 'UInt64', nullable: true, isArray: false });
  });

  it('unwraps LowCardinality(...) — transparent for the effective base — without flagging it as nullable', () => {
    const t = parseParamType('LowCardinality(UInt64)');
    expect(t).toMatchObject({ raw: 'LowCardinality(UInt64)', base: 'UInt64', nullable: false, isArray: false });
  });

  it('unwraps LowCardinality(Nullable(T)) — both flags, effective base', () => {
    const t = parseParamType('LowCardinality(Nullable(String))');
    expect(t).toMatchObject({ base: 'String', nullable: true });
  });

  it('unwraps LowCardinality recursively inside Array(...)', () => {
    const t = parseParamType('Array(LowCardinality(UInt64))');
    expect(t.isArray).toBe(true);
    expect(t.elem.base).toBe('UInt64');
    expect(t.elem.nullable).toBe(false);
  });

  it('parses Array(Nullable(T)) — nullable element', () => {
    const t = parseParamType('Array(Nullable(String))');
    expect(t.isArray).toBe(true);
    expect(t.elem.base).toBe('String');
    expect(t.elem.nullable).toBe(true);
  });

  it('parses nested arrays (recognized so the serializer can reject them)', () => {
    const t = parseParamType('Array(Array(UInt8))');
    expect(t.isArray).toBe(true);
    expect(t.elem.isArray).toBe(true);
    expect(t.elem.elem.base).toBe('UInt8');
  });

  it('trims input and tolerates inner whitespace', () => {
    expect(parseParamType('  Array( String ) ').elem.base).toBe('String');
  });

  it('degrades an unparsable shape to an opaque scalar', () => {
    const t = parseParamType('Array(String'); // unbalanced — no trailing ')'
    expect(t.base).toBe('Array(String');
    expect(t.isArray).toBe(false);
    expect(t.elem).toBeNull();
    expect(t.node).toBeNull();
    expect(parseParamType('').base).toBe('');
    expect(parseParamType(null).base).toBe('');
  });

  it('a bare Array (no parens at all) is malformed — degrades to an opaque scalar, not an array', () => {
    const t = parseParamType('Array');
    expect(t.isArray).toBe(false);
    expect(t.elem).toBeNull();
    expect(t.base).toBe('Array');
  });
});

describe('typeLexKind', () => {
  it('classifies integer bases (including the big ones)', () => {
    for (const t of ['Int8', 'UInt8', 'UInt32', 'UInt64', 'Int128', 'UInt256']) {
      expect(typeLexKind(t)).toBe('int');
    }
  });
  it('classifies float/decimal bases', () => {
    for (const t of ['Float32', 'Float64', 'BFloat16', 'Decimal', 'Decimal(10, 2)', 'Decimal64']) {
      expect(typeLexKind(t)).toBe('float');
    }
  });
  it('classifies Bool/Boolean', () => {
    expect(typeLexKind('Bool')).toBe('bool');
    expect(typeLexKind('Boolean')).toBe('bool');
  });
  it('everything else is text (quoted), including dates / UUID / unknowns', () => {
    for (const t of ['String', 'FixedString(4)', 'UUID', 'Date', 'DateTime', "Enum8('a' = 1)", 'IPv4', 'Whatever']) {
      expect(typeLexKind(t)).toBe('text');
    }
  });
  it('accepts an already-parsed type object', () => {
    expect(typeLexKind(parseParamType('UInt64'))).toBe('int');
  });
  it('classifies a LowCardinality-wrapped base the same as the unwrapped type', () => {
    expect(typeLexKind('LowCardinality(UInt64)')).toBe('int');
    expect(typeLexKind('LowCardinality(Float64)')).toBe('float');
    expect(typeLexKind('LowCardinality(Bool)')).toBe('bool');
    expect(typeLexKind('LowCardinality(UUID)')).toBe('text');
  });
});

describe('conflictingTypes', () => {
  it('null when every declaration agrees (whitespace-insensitively)', () => {
    expect(conflictingTypes([{ type: 'String' }, { type: 'String' }])).toBeNull();
    expect(conflictingTypes([{ type: 'Array( String )' }, { type: 'Array(String)' }])).toBeNull();
    expect(conflictingTypes([])).toBeNull();
    expect(conflictingTypes(null)).toBeNull();
  });
  it('returns the distinct canonical set, first-seen order, on a disagreement', () => {
    expect(conflictingTypes([{ type: 'UInt64' }, { type: 'String' }, { type: 'UInt64' }]))
      .toEqual(['UInt64', 'String']);
  });
  it('is wrapper-sensitive — LowCardinality(String) is a different declaration from String', () => {
    expect(conflictingTypes([{ type: 'String' }, { type: 'LowCardinality(String)' }]))
      .toEqual(['String', 'LowCardinality(String)']);
  });
});

// #172 v1 — parsing an Enum declaration's members straight out of the type text.
describe('enumMembers / enumValues', () => {
  it('parses Enum8 members in declaration order', () => {
    expect(enumMembers("Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)")).toEqual([
      { name: 'active', code: 1 },
      { name: 'deleted', code: 2 },
      { name: 'banned', code: 3 },
    ]);
    expect(enumValues("Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)")).toEqual(['active', 'deleted', 'banned']);
  });

  it('parses Enum16 the same way', () => {
    expect(enumValues("Enum16('a' = 1, 'b' = 2)")).toEqual(['a', 'b']);
  });

  it('unescapes a doubled single quote inside a member name', () => {
    expect(enumValues("Enum8('a''b' = 1)")).toEqual(["a'b"]);
  });

  it('decodes $$…$$ heredoc member names verbatim', () => {
    expect(enumValues('Enum8($$foo$$ = 1)')).toEqual(['foo']);
  });

  it('rejects quoted-identifier members', () => {
    expect(enumValues('Enum8("foo" = 1)')).toBeNull();
    expect(enumMembers('Enum8("foo" = 1)')).toEqual([]);
  });

  it('unwraps Nullable(Enum8(...))', () => {
    expect(enumValues("Nullable(Enum8('a' = 1, 'b' = 2))")).toEqual(['a', 'b']);
  });

  it('unwraps LowCardinality(Enum8(...)) — LowCardinality is transparent for Enum behavior', () => {
    expect(enumValues("LowCardinality(Enum8('a' = 1, 'b' = 2))")).toEqual(['a', 'b']);
  });

  it('unwraps LowCardinality(Nullable(Enum8(...)))', () => {
    expect(enumValues("LowCardinality(Nullable(Enum8('a' = 1)))")).toEqual(['a']);
  });

  it('returns null for a non-enum type', () => {
    for (const t of ['String', 'UInt8', 'Array(String)', 'FixedString(4)']) {
      expect(enumValues(t)).toBeNull();
      expect(enumMembers(t)).toBeNull();
    }
  });

  it('accepts an already-parsed type object, same as parseParamType-family siblings', () => {
    expect(enumValues(parseParamType("Enum8('a' = 1)"))).toEqual(['a']);
  });

  it('fully-implicit members auto-number from 1', () => {
    expect(enumMembers("Enum8('hello', 'world')")).toEqual([
      { name: 'hello', code: 1 },
      { name: 'world', code: 2 },
    ]);
  });

  it('a bare Enum8 with no member list: enumMembers [] but enumValues null — never an empty dropdown', () => {
    expect(enumMembers('Enum8')).toEqual([]);
    expect(enumValues('Enum8')).toBeNull();
    expect(enumValues('Enum8()')).toBeNull();
  });

  it('a malformed (unparseable) Enum-looking declaration is opaque, not an Enum with zero members', () => {
    expect(enumValues("Enum8('unterminated")).toBeNull();
    expect(enumMembers("Enum8('unterminated")).toBeNull();
  });
});
