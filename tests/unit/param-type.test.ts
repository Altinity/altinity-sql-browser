import { describe, it, expect } from 'vitest';
import {
  parseParamType,
  typeLexKind,
  conflictingTypes,
  enumMembers,
  enumValues,
  boolCheckboxChecked,
  isSupportedTimeRangeParamType,
  dateTimeTimeZone,
  isCompoundParamType,
  multiSelectElementType,
  isSupportedOptionScalar,
} from '../../src/core/param-type.js';
// Issue #630 Phase 5 — `isSupportedOptionScalar` moved from the generic
// grammar module (SQL Browser option/control policy, not generic ClickHouse
// grammar) to this file; its describe block moved from
// tests/unit/clickhouse-type.test.ts along with it. `parseClickHouseType`
// is only used here to build fixture AST nodes.
import { parseClickHouseType } from '@altinity/clickhouse-http';

describe('boolCheckboxChecked', () => {
  it('preserves every confirmed true spelling across a Dashboard rebuild', () => {
    for (const value of [true, 'true', '1', 'Yes', 'ON', 't', 'Y']) {
      expect(boolCheckboxChecked(value)).toBe(true);
    }
  });

  it('leaves false, unknown, and non-string values unchecked', () => {
    for (const value of [false, 'false', '0', 'no', 'off', 'enable', 1, null, undefined]) {
      expect(boolCheckboxChecked(value)).toBe(false);
    }
  });
});

// #447 phase 2: named so a single-scalar surface can say "no control for this"
// rather than render one that cannot produce a valid value.
describe('isCompoundParamType', () => {
  it('is true for the container types', () => {
    expect(isCompoundParamType('Array(String)')).toBe(true);
    expect(isCompoundParamType('Tuple(String, UInt8)')).toBe(true);
    expect(isCompoundParamType('Tuple(a String, b UInt8)')).toBe(true);
    expect(isCompoundParamType('Map(String, UInt64)')).toBe(true);
    expect(isCompoundParamType('Nested(a String)')).toBe(true);
  });

  it('sees through the value-transparent wrappers', () => {
    expect(isCompoundParamType('Nullable(Array(String))')).toBe(true);
    expect(isCompoundParamType('LowCardinality(String)')).toBe(false);
  });

  it('is false for every scalar', () => {
    for (const type of ['String', 'UInt64', 'Float64', 'Date', 'DateTime64(3)', 'Bool', 'UUID', "Enum8('a' = 1)"]) {
      expect(isCompoundParamType(type)).toBe(false);
    }
    expect(isCompoundParamType('')).toBe(false);
  });

  it('still recognizes a container the shared parser cannot read', () => {
    // These degrade to an opaque scalar whose `base` is the whole declaration
    // text, so an exact base match would miss them — `Nested` has no grammar in
    // the parser at all, and an unbalanced paren never parses.
    expect(isCompoundParamType('Nested(a String, b UInt8)')).toBe(true);
    expect(isCompoundParamType('Array(')).toBe(true);
  });

  it('does not match a scalar whose name merely starts with a container name', () => {
    expect(isCompoundParamType('ArrayLike')).toBe(false);
    expect(isCompoundParamType('Mapping')).toBe(false);
  });

  it('accepts an already-parsed type', () => {
    expect(isCompoundParamType(parseParamType('Array(UInt8)'))).toBe(true);
    expect(isCompoundParamType(parseParamType('String'))).toBe(false);
  });
});

// The single eligibility decision behind the restored Array(T) multi-select:
// the option batch and the control dispatch both filter on THIS, so a type that
// gets a select can never be one whose option SQL was skipped.
describe('multiSelectElementType', () => {
  it('yields the element type for an Array of a scalar', () => {
    expect(multiSelectElementType('Array(String)')?.base).toBe('String');
    expect(multiSelectElementType('Array(UInt64)')?.base).toBe('UInt64');
    expect(multiSelectElementType('Array(Int32)')?.base).toBe('Int32');
    expect(multiSelectElementType("Array(Enum8('a' = 1))")?.base).toBe('Enum8');
  });

  it('sees through the value-transparent wrappers, on the array AND its element', () => {
    // `parseParamType` unwraps Nullable/LowCardinality recursively, so the
    // element handed back is already the EFFECTIVE scalar the serializer lexes.
    expect(multiSelectElementType('Nullable(Array(String))')?.base).toBe('String');
    expect(multiSelectElementType('Array(LowCardinality(String))')?.base).toBe('String');
    expect(multiSelectElementType('Array(Nullable(UInt64))')?.base).toBe('UInt64');
  });

  it('is null for a scalar — there is nothing to multi-select', () => {
    for (const type of ['String', 'UInt64', 'Date', 'DateTime64(3)', 'Bool', "Enum8('a' = 1)"]) {
      expect(multiSelectElementType(type)).toBeNull();
    }
    expect(multiSelectElementType('')).toBeNull();
  });

  it('is null for a container with no flat element list', () => {
    for (const type of ['Tuple(String, UInt8)', 'Map(String, UInt64)', 'Nested(a String)']) {
      expect(multiSelectElementType(type)).toBeNull();
    }
  });

  it('is null for a nested array, which the serializer rejects outright', () => {
    // `param-serialize.js` refuses both nested array VALUES and nested `Array`
    // DECLARATIONS, so a control that produced one could never bind.
    expect(multiSelectElementType('Array(Array(String))')).toBeNull();
    expect(multiSelectElementType('Array(Nullable(Array(String)))')).toBeNull();
  });

  it('is null for an Array of a non-array container', () => {
    expect(multiSelectElementType('Array(Tuple(String, UInt8))')).toBeNull();
    expect(multiSelectElementType('Array(Map(String, UInt64))')).toBeNull();
  });

  it('is null for an Array the shared parser cannot read', () => {
    // Degrades to an opaque scalar whose `base` is the whole text, so `isArray`
    // is false and there is no `elem` to offer.
    expect(multiSelectElementType('Array(')).toBeNull();
  });

  it('accepts an already-parsed type', () => {
    expect(multiSelectElementType(parseParamType('Array(UInt8)'))?.base).toBe('UInt8');
    expect(multiSelectElementType(parseParamType('String'))).toBeNull();
  });
});

describe('isSupportedTimeRangeParamType', () => {
  it('accepts supported scalar date/time declarations and valid wrappers', () => {
    for (const type of [
      'Date', 'Date32', 'DateTime', "DateTime('UTC')", 'DateTime64(0)',
      "DateTime64(9, 'Europe/Berlin')", 'Nullable(Date)',
      'LowCardinality(DateTime)', 'LowCardinality(Nullable(DateTime64(3)))',
    ]) expect(isSupportedTimeRangeParamType(type), type).toBe(true);
  });

  it('rejects non-date, arrays, malformed arguments, precision overflow, and invalid wrapper order', () => {
    for (const type of [
      'String', 'UInt64', 'Array(Date)', 'Date(1)', "DateTime('')", "DateTime('   ')", 'DateTime(3)',
      'DateTime64', "DateTime64('x')", 'DateTime64(10)', "DateTime64(3, '')", "DateTime64(3, '   ')", 'DateTime64(3, 4)',
      'Nullable(LowCardinality(DateTime))', 'nope(', '',
    ]) expect(isSupportedTimeRangeParamType(type), type).toBe(false);
  });
});

describe('dateTimeTimeZone', () => {
  it('extracts explicit DateTime zones and fails closed for opaque types', () => {
    expect(dateTimeTimeZone("DateTime('UTC')")).toBe('UTC');
    expect(dateTimeTimeZone("DateTime64(3, 'Europe/Berlin')")).toBe('Europe/Berlin');
    expect(dateTimeTimeZone('DateTime')).toBeNull();
    expect(dateTimeTimeZone('nope(')).toBeNull();
  });
});

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
    expect(t.elem!.base).toBe('String');
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
    expect(t.elem!.base).toBe('UInt64');
    expect(t.elem!.nullable).toBe(false);
  });

  it('parses Array(Nullable(T)) — nullable element', () => {
    const t = parseParamType('Array(Nullable(String))');
    expect(t.isArray).toBe(true);
    expect(t.elem!.base).toBe('String');
    expect(t.elem!.nullable).toBe(true);
  });

  it('parses nested arrays (recognized so the serializer can reject them)', () => {
    const t = parseParamType('Array(Array(UInt8))');
    expect(t.isArray).toBe(true);
    expect(t.elem!.isArray).toBe(true);
    expect(t.elem!.elem!.base).toBe('UInt8');
  });

  it('trims input and tolerates inner whitespace', () => {
    expect(parseParamType('  Array( String ) ').elem!.base).toBe('String');
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

  // No ClickHouse version accepts LowCardinality wrapping an Enum — degrades
  // exactly like an unparseable declaration: opaque passthrough, `base` is
  // the whole raw declaration text, no Enum-specific behavior anywhere.
  it('LowCardinality(Enum8(...)) degrades to an opaque scalar, in any nesting order', () => {
    const t = parseParamType("LowCardinality(Enum8('a' = 1))");
    expect(t.base).toBe("LowCardinality(Enum8('a' = 1))");
    expect(t.node).toBeNull();
    expect(t.isArray).toBe(false);
    const nested = parseParamType("Nullable(LowCardinality(Enum8('a' = 1)))");
    expect(nested.node).toBeNull();
    const inArray = parseParamType("Array(LowCardinality(Enum8('a' = 1)))");
    expect(inArray.isArray).toBe(true);
    expect(inArray.elem!.node).toBeNull();
    expect(inArray.elem!.base).toBe("LowCardinality(Enum8('a' = 1))");
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

  // No ClickHouse version accepts LowCardinality wrapping an Enum at all
  // (live-verified 26.3.13: ILLEGAL_TYPE_OF_ARGUMENT) — unlike Nullable
  // ordering, parameter handling does NOT stay permissive about this one;
  // it degrades exactly like an unparseable declaration.
  it('rejects LowCardinality(Enum8(...)) in any nesting order — no Enum behavior for a type no server accepts', () => {
    expect(enumValues("LowCardinality(Enum8('a' = 1, 'b' = 2))")).toBeNull();
    expect(enumValues("LowCardinality(Nullable(Enum8('a' = 1)))")).toBeNull();
    expect(enumValues("Nullable(LowCardinality(Enum8('a' = 1)))")).toBeNull();
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

// #630 Phase 5 — moved from tests/unit/clickhouse-type.test.ts along with the
// relocated `isSupportedOptionScalar` implementation: this is SQL Browser
// option/control policy (which scalar families are eligible for an
// option-backed scalar control), not generic ClickHouse grammar, so it stays
// out of the package's own corpus.
describe('isSupportedOptionScalar', () => {
  it('classifies supported scalars through Nullable/LowCardinality in valid orders', () => {
    for (const value of ['String', 'FixedString(3)', 'UUID', 'UInt256', 'Int8', 'Decimal(20, 4)', 'Float64', 'Bool', 'Date32', 'DateTime64(3)']) {
      expect(isSupportedOptionScalar(parseClickHouseType(`Nullable(${value})`))).toBe(true);
      expect(isSupportedOptionScalar(parseClickHouseType(`LowCardinality(${value})`))).toBe(true);
      expect(isSupportedOptionScalar(parseClickHouseType(`LowCardinality(Nullable(${value}))`))).toBe(true);
    }
  });

  it('classifies a bare or Nullable-wrapped Enum as a supported scalar, but never LowCardinality-wrapped', () => {
    expect(isSupportedOptionScalar(parseClickHouseType("Enum8('a' = 1)"))).toBe(true);
    expect(isSupportedOptionScalar(parseClickHouseType("Nullable(Enum8('a' = 1))"))).toBe(true);
    expect(isSupportedOptionScalar(parseClickHouseType("LowCardinality(Enum8('a' = 1))"))).toBe(false);
    expect(isSupportedOptionScalar(parseClickHouseType("LowCardinality(Nullable(Enum8('a' = 1)))"))).toBe(false);
    expect(isSupportedOptionScalar(parseClickHouseType("Nullable(LowCardinality(Enum8('a' = 1)))"))).toBe(false);
  });

  it('rejects a semantically invalid wrapper order even though the inner type is a supported scalar', () => {
    expect(isSupportedOptionScalar(parseClickHouseType('Nullable(LowCardinality(String))'))).toBe(false);
  });

  it('rejects composite and unrecognized types', () => {
    expect(isSupportedOptionScalar(parseClickHouseType('Array(String)'))).toBe(false);
    expect(isSupportedOptionScalar(null)).toBe(false);
  });
});
