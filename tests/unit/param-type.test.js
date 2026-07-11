import { describe, it, expect } from 'vitest';
import {
  parseParamType,
  normalizeParamType,
  typeLexKind,
  conflictingTypes,
} from '../../src/core/param-type.js';

describe('parseParamType', () => {
  it('parses a bare scalar', () => {
    expect(parseParamType('String')).toEqual({
      raw: 'String', base: 'String', inner: null, nullable: false, isArray: false, elem: null,
    });
  });

  it('parses a parameterized scalar (args kept raw)', () => {
    const t = parseParamType('Decimal(10, 2)');
    expect(t.base).toBe('Decimal');
    expect(t.inner).toBe('10, 2');
    expect(t.isArray).toBe(false);
    expect(t.elem).toBeNull();
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
    expect(parseParamType('').base).toBe('');
    expect(parseParamType(null).base).toBe('');
  });

  it('a bare Array (no element type) has no elem', () => {
    const t = parseParamType('Array');
    expect(t.isArray).toBe(true);
    expect(t.elem).toBeNull();
  });
});

describe('normalizeParamType', () => {
  it('collapses whitespace and tolerates nullish input', () => {
    expect(normalizeParamType('Array( String )')).toBe('Array(String)');
    expect(normalizeParamType('Map(String, UInt8)')).toBe('Map(String,UInt8)');
    expect(normalizeParamType(null)).toBe('');
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
});

describe('conflictingTypes', () => {
  it('null when every declaration agrees (whitespace-insensitively)', () => {
    expect(conflictingTypes([{ type: 'String' }, { type: 'String' }])).toBeNull();
    expect(conflictingTypes([{ type: 'Array( String )' }, { type: 'Array(String)' }])).toBeNull();
    expect(conflictingTypes([])).toBeNull();
    expect(conflictingTypes(null)).toBeNull();
  });
  it('returns the distinct normalized set, first-seen order, on a disagreement', () => {
    expect(conflictingTypes([{ type: 'UInt64' }, { type: 'String' }, { type: 'UInt64' }]))
      .toEqual(['UInt64', 'String']);
  });
});
