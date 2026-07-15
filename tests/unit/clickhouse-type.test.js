import { describe, expect, it } from 'vitest';
import {
  analyzeTypeModifiers, arrayElement, canonicalType, enumMembers, enumValues,
  isSupportedOptionScalar, mapTypes, namedTupleMembers, parseClickHouseType,
  typeBaseName, unwrapLowCardinality, unwrapNullable, unwrapValueTransparentWrappers,
} from '../../src/core/clickhouse-type.js';

describe('parseClickHouseType — parser', () => {
  it('rejects empty and whitespace-only input', () => {
    expect(parseClickHouseType('')).toBeNull();
    expect(parseClickHouseType('   ')).toBeNull();
    expect(parseClickHouseType(null)).toBeNull();
    expect(parseClickHouseType(undefined)).toBeNull();
  });

  it('parses a bare scalar', () => {
    const node = parseClickHouseType('String');
    expect(node).toEqual({ kind: 'type', name: 'String', raw: 'String', args: [], members: null });
  });

  it('trims surrounding whitespace and tolerates inner whitespace', () => {
    expect(parseClickHouseType('  UInt64  ').name).toBe('UInt64');
    expect(parseClickHouseType(' Array( String ) ').raw).toBe('Array( String )');
  });

  it('parses nested wrappers in both valid orders', () => {
    expect(parseClickHouseType('LowCardinality(Nullable(String))').name).toBe('LowCardinality');
    expect(parseClickHouseType('Nullable(LowCardinality(String))').name).toBe('Nullable');
    expect(parseClickHouseType('Nullable(String)').args[0].name).toBe('String');
    expect(parseClickHouseType('LowCardinality(UInt64)').args[0].name).toBe('UInt64');
  });

  it('parses numeric arguments as number-literal nodes, not fake types', () => {
    const decimal = parseClickHouseType('Decimal(20, 4)');
    expect(decimal.args).toEqual([
      { kind: 'number', value: '20', raw: '20' },
      { kind: 'number', value: '4', raw: '4' },
    ]);
    const fixed = parseClickHouseType('FixedString(16)');
    expect(fixed.args).toEqual([{ kind: 'number', value: '16', raw: '16' }]);
  });

  it('parses quoted string arguments as string-literal nodes', () => {
    const dt = parseClickHouseType("DateTime('Europe/Madrid')");
    expect(dt.args).toEqual([{ kind: 'string', value: 'Europe/Madrid', raw: "'Europe/Madrid'" }]);
    const dt64 = parseClickHouseType("DateTime64(3, 'UTC')");
    expect(dt64.args).toEqual([
      { kind: 'number', value: '3', raw: '3' },
      { kind: 'string', value: 'UTC', raw: "'UTC'" },
    ]);
  });

  it('unescapes a backslash-escaped quote inside a string-literal argument', () => {
    const dt = parseClickHouseType("DateTime('it\\'s')");
    expect(dt.args[0]).toEqual({ kind: 'string', value: "it's", raw: "'it\\'s'" });
  });

  it('parses positional and named Tuple members', () => {
    expect(parseClickHouseType('Tuple(String, UInt64)').args.map((a) => a.name)).toEqual(['String', 'UInt64']);
    const named = parseClickHouseType('Tuple(value String, count UInt64)');
    expect(named.members.map((m) => [m.name, m.type.name])).toEqual([['value', 'String'], ['count', 'UInt64']]);
  });

  it('rejects a Tuple mixing named and positional members', () => {
    expect(parseClickHouseType('Tuple(name String, UInt8)')).toBeNull();
  });

  it('parses Map and Array', () => {
    expect(parseClickHouseType('Map(String, UInt64)').name).toBe('Map');
    expect(parseClickHouseType('Array(String)').args[0].name).toBe('String');
  });

  it('parses nested combinations', () => {
    const parsed = parseClickHouseType(' Nullable( Array( Tuple( `label name` String, value Decimal(10, 2) ) ) ) ');
    expect(unwrapNullable(parsed).name).toBe('Array');
    const members = namedTupleMembers(arrayElement(parsed));
    expect(members.map((m) => [m.name, m.type.raw])).toEqual([
      ['label name', 'String'], ['value', 'Decimal(10, 2)'],
    ]);
  });

  it('rejects malformed parentheses', () => {
    for (const value of ['Array(', 'Array(String))', '(String)', 'Array)String(']) {
      expect(parseClickHouseType(value)).toBeNull();
    }
  });

  it('rejects malformed commas', () => {
    for (const value of ['Map(String)', 'Map(String,)', 'Array(,String)', 'Tuple(,)', 'Map(String UInt8)']) {
      expect(parseClickHouseType(value)).toBeNull();
    }
  });

  it('rejects a named Tuple member whose name has nothing after it', () => {
    expect(parseClickHouseType('Tuple(`x`')).toBeNull();
  });

  it('rejects unterminated quotes', () => {
    expect(parseClickHouseType("DateTime('UTC)")).toBeNull();
    expect(parseClickHouseType('Tuple(`unterminated String)')).toBeNull();
  });

  it('rejects wrong arity for Array/Nullable/LowCardinality/Map', () => {
    for (const value of ['Array', 'Nullable(String, String)', 'LowCardinality(String, String)', 'Map(String)', 'Map(String, UInt8, UInt8)']) {
      expect(parseClickHouseType(value)).toBeNull();
    }
  });

  it('rejects a literal argument where Array/Nullable/LowCardinality/Map require a nested type', () => {
    for (const value of ['Array(123)', "Nullable('x')", 'LowCardinality(16)', "Map(String, 'x')"]) {
      expect(parseClickHouseType(value)).toBeNull();
    }
  });

  it('a `$` that is not a valid heredoc opener falls through to an ordinary bare-word token', () => {
    expect(parseClickHouseType('$foo')).toEqual({ kind: 'type', name: '$foo', raw: '$foo', args: [], members: null });
  });

  it('a bare Array (no parens at all) is malformed, not an ordinary array', () => {
    expect(parseClickHouseType('Array')).toBeNull();
  });

  it('parses empty parens as a zero-arg node (rejected by arity when one is required)', () => {
    expect(parseClickHouseType('Tuple()')).toEqual({ kind: 'type', name: 'Tuple', raw: 'Tuple()', args: [], members: null });
    expect(parseClickHouseType('Array()')).toBeNull();
  });

  it('rejects a trailing token after an otherwise-complete type', () => {
    expect(parseClickHouseType('String Extra')).toBeNull();
  });

  describe('Enum8/Enum16 member parsing', () => {
    it('parses explicit codes in declaration order', () => {
      const node = parseClickHouseType("Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)");
      expect(node.name).toBe('Enum8');
      expect(node.raw).toBe("Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)");
      expect(node.enumMembers).toEqual([
        { name: 'active', code: 1 }, { name: 'deleted', code: 2 }, { name: 'banned', code: 3 },
      ]);
    });

    it('parses implicit codes, auto-numbering from 1 and continuing after an explicit code', () => {
      expect(parseClickHouseType("Enum8('hello', 'world')").enumMembers).toEqual([
        { name: 'hello', code: 1 }, { name: 'world', code: 2 },
      ]);
      expect(parseClickHouseType("Enum8('One' = 1, 'Two', 'Three')").enumMembers).toEqual([
        { name: 'One', code: 1 }, { name: 'Two', code: 2 }, { name: 'Three', code: 3 },
      ]);
      expect(parseClickHouseType("Enum8('a', 'b' = 10, 'c')").enumMembers).toEqual([
        { name: 'a', code: 1 }, { name: 'b', code: 10 }, { name: 'c', code: 11 },
      ]);
    });

    it('parses negative codes, incl. an implicit member continuing upward from one', () => {
      expect(parseClickHouseType("Enum8('neg' = -5, 'zero' = 0)").enumMembers).toEqual([
        { name: 'neg', code: -5 }, { name: 'zero', code: 0 },
      ]);
      expect(parseClickHouseType("Enum8('a' = -2, 'b')").enumMembers).toEqual([
        { name: 'a', code: -2 }, { name: 'b', code: -1 },
      ]);
    });

    it('unescapes and decodes escaped member names', () => {
      expect(parseClickHouseType("Enum8('a''b' = 1)").enumMembers).toEqual([{ name: "a'b", code: 1 }]);
      expect(parseClickHouseType("Enum8('a\\'b' = 1)").enumMembers).toEqual([{ name: "a'b", code: 1 }]);
      expect(parseClickHouseType("Enum8('}' = 1, 'ok' = 2)").enumMembers).toEqual([{ name: '}', code: 1 }, { name: 'ok', code: 2 }]);
    });

    it('decodes $tag$…$tag$ heredoc member names verbatim, including embedded parens/commas/quotes', () => {
      expect(parseClickHouseType('Enum8($$foo$$ = 1)').enumMembers).toEqual([{ name: 'foo', code: 1 }]);
      expect(parseClickHouseType("Enum8($tag$a,b)$tag$ = 1)").enumMembers).toEqual([{ name: 'a,b)', code: 1 }]);
      expect(parseClickHouseType("Enum8($$a$$ = 1, 'b' = 2)").enumMembers).toEqual([{ name: 'a', code: 1 }, { name: 'b', code: 2 }]);
      // #238 regression: a heredoc body containing a lone `'` used to corrupt
      // the whole tokenizer (the naive quote-scan doesn't know heredocs exist)
      // — the tokenizer now atomizes the heredoc BEFORE the quote branch ever
      // sees the embedded `'`.
      expect(parseClickHouseType("Enum8($tag$hello 'world$tag$ = 1)").enumMembers).toEqual([{ name: "hello 'world", code: 1 }]);
    });

    it('a heredoc member wrapped in an outer type still resyncs the token cursor correctly', () => {
      const node = parseClickHouseType("Array(Enum8($tag$a,b)$tag$ = 1, 'c' = 2))");
      expect(node.name).toBe('Array');
      expect(node.args[0].enumMembers).toEqual([{ name: 'a,b)', code: 1 }, { name: 'c', code: 2 }]);
    });

    it('rejects an unterminated heredoc opener', () => {
      expect(parseClickHouseType('Enum8($tag$abc = 1)')).toBeNull();
    });

    it('drops a member whose quote is truncated by the tokenizer finding an earlier close paren than scanSpans would (pathological backslash-run divergence, #238 review)', () => {
      // The tokenizer's naive single-char backslash lookback disagrees with
      // scanSpans' proper escape-pair counting on an EVEN backslash run
      // before a quote: `'a\\'` is one complete escaped-backslash-then-real-
      // close per scanSpans, but the naive tokenizer thinks the close is
      // itself escaped and keeps scanning — here it accidentally closes
      // against the SECOND member's opening quote, swallowing the real `)`
      // into that span and leaving the second member's quote genuinely
      // unterminated within the (now wrongly bounded) member-list text. The
      // first member still parses correctly; the truncated second is dropped,
      // not fabricated from leftover text.
      expect(parseClickHouseType("Enum8('a\\\\' = 1, 'b)").enumMembers).toEqual([{ name: 'a\\', code: 1 }]);
    });

    it('rejects quoted-identifier members and unterminated literals as members, without failing the parse', () => {
      expect(parseClickHouseType('Enum8("foo" = 1)').enumMembers).toEqual([]);
    });

    it('rejects an unterminated Enum member list', () => {
      expect(parseClickHouseType("Enum8('a' = 1")).toBeNull();
    });

    it('a bare Enum8 with no member list has an empty member array', () => {
      expect(parseClickHouseType('Enum8()').enumMembers).toEqual([]);
    });

    it('tolerates (invalid, but structurally balanced) nested parens in a member code assignment', () => {
      // Not valid ClickHouse syntax, but the boundary scanner is generic —
      // it just needs to find the matching close paren, and its own nested
      // parens tolerate arbitrary depth.
      expect(parseClickHouseType("Enum8('a' = (1))").enumMembers).toEqual([{ name: 'a', code: 1 }]);
    });
  });

  describe('bare Enum8/16 (no parens at all)', () => {
    it('parses as a scalar node with no enumMembers field at all', () => {
      const node = parseClickHouseType('Enum8');
      expect(node).toEqual({ kind: 'type', name: 'Enum8', raw: 'Enum8', args: [], members: null });
      expect(enumMembers(node)).toEqual([]);
      expect(enumValues(node)).toBeNull();
    });
  });
});

describe('wrapper helpers', () => {
  it('unwrapNullable strips only Nullable', () => {
    expect(unwrapNullable(parseClickHouseType('Nullable(String)')).name).toBe('String');
    expect(unwrapNullable(parseClickHouseType('LowCardinality(String)')).name).toBe('LowCardinality');
    expect(unwrapNullable(null)).toBeNull();
  });

  it('unwrapLowCardinality strips only LowCardinality', () => {
    expect(unwrapLowCardinality(parseClickHouseType('LowCardinality(String)')).name).toBe('String');
    expect(unwrapLowCardinality(parseClickHouseType('Nullable(String)')).name).toBe('Nullable');
    expect(unwrapLowCardinality(null)).toBeNull();
  });

  it('unwrapValueTransparentWrappers strips both, in either nesting order', () => {
    expect(unwrapValueTransparentWrappers(parseClickHouseType('LowCardinality(Nullable(String))')).name).toBe('String');
    expect(unwrapValueTransparentWrappers(parseClickHouseType('Nullable(LowCardinality(String))')).name).toBe('String');
    expect(unwrapValueTransparentWrappers(parseClickHouseType('String')).name).toBe('String');
    expect(unwrapValueTransparentWrappers(null)).toBeNull();
  });

  it('analyzeTypeModifiers reports the effective type, flags, order, and validity', () => {
    expect(analyzeTypeModifiers(parseClickHouseType('String'))).toEqual({
      valueType: parseClickHouseType('String'), nullable: false, lowCardinality: false, wrapperOrder: [], valid: true,
    });
    expect(analyzeTypeModifiers(parseClickHouseType('LowCardinality(Nullable(String))'))).toMatchObject({
      nullable: true, lowCardinality: true, wrapperOrder: ['LowCardinality', 'Nullable'], valid: true,
    });
    expect(analyzeTypeModifiers(parseClickHouseType('Nullable(LowCardinality(String))'))).toMatchObject({
      nullable: true, lowCardinality: true, wrapperOrder: ['Nullable', 'LowCardinality'], valid: false,
    });
    expect(analyzeTypeModifiers(null).valueType).toBeNull();
  });
});

describe('structural queries', () => {
  it('typeBaseName returns the type name, or null for a literal arg or missing node', () => {
    expect(typeBaseName(parseClickHouseType('UInt64'))).toBe('UInt64');
    expect(typeBaseName(parseClickHouseType('Decimal(10, 2)').args[0])).toBeNull();
    expect(typeBaseName(null)).toBeNull();
  });

  it('arrayElement/mapTypes/namedTupleMembers unwrap Nullable but not LowCardinality (Array/Map/Tuple can never be LowCardinality)', () => {
    expect(arrayElement(parseClickHouseType('Nullable(Array(String))')).name).toBe('String');
    expect(arrayElement(parseClickHouseType('String'))).toBeNull();
    expect(arrayElement(null)).toBeNull();
    expect(mapTypes(parseClickHouseType('Map(String, Nullable(UInt64))')).map((n) => n.name)).toEqual(['String', 'Nullable']);
    expect(mapTypes(parseClickHouseType('String'))).toBeNull();
    expect(mapTypes(null)).toBeNull();
    expect(namedTupleMembers(parseClickHouseType('Tuple(String, UInt64)'))).toBeNull();
    expect(namedTupleMembers(parseClickHouseType('String'))).toBeNull();
  });

  it('enumMembers/enumValues unwrap Nullable and LowCardinality, in either order', () => {
    expect(enumValues(parseClickHouseType("Enum8('a' = 1, 'b' = 2)"))).toEqual(['a', 'b']);
    expect(enumValues(parseClickHouseType("Nullable(Enum8('a' = 1, 'b' = 2))"))).toEqual(['a', 'b']);
    expect(enumValues(parseClickHouseType("LowCardinality(Enum8('a' = 1, 'b' = 2))"))).toEqual(['a', 'b']);
    expect(enumValues(parseClickHouseType("LowCardinality(Nullable(Enum8('a' = 1)))"))).toEqual(['a']);
    expect(enumMembers(parseClickHouseType('String'))).toBeNull();
    expect(enumValues(parseClickHouseType('String'))).toBeNull();
  });

  it('enumValues is null (never []) for an enum whose member list yields nothing', () => {
    expect(enumValues(parseClickHouseType('Enum8()'))).toBeNull();
  });
});

describe('isSupportedOptionScalar', () => {
  it('classifies supported scalars through Nullable/LowCardinality in valid orders', () => {
    for (const value of ['String', 'FixedString(3)', 'UUID', 'UInt256', 'Int8', 'Decimal(20, 4)', 'Float64', 'Bool', 'Date32', 'DateTime64(3)', "Enum8('a' = 1)"]) {
      expect(isSupportedOptionScalar(parseClickHouseType(`Nullable(${value})`))).toBe(true);
      expect(isSupportedOptionScalar(parseClickHouseType(`LowCardinality(${value})`))).toBe(true);
      expect(isSupportedOptionScalar(parseClickHouseType(`LowCardinality(Nullable(${value}))`))).toBe(true);
    }
  });

  it('rejects a semantically invalid wrapper order even though the inner type is a supported scalar', () => {
    expect(isSupportedOptionScalar(parseClickHouseType('Nullable(LowCardinality(String))'))).toBe(false);
  });

  it('rejects composite and unrecognized types', () => {
    expect(isSupportedOptionScalar(parseClickHouseType('Array(String)'))).toBe(false);
    expect(isSupportedOptionScalar(null)).toBe(false);
  });
});

describe('canonicalType', () => {
  it('collapses whitespace outside quoted content', () => {
    expect(canonicalType('Array( String )')).toBe('Array(String)');
    expect(canonicalType("DateTime( 'UTC' )")).toBe("DateTime('UTC')");
    expect(canonicalType(null)).toBe('');
  });

  it('preserves whitespace inside a quoted Enum member name while still collapsing it outside', () => {
    expect(canonicalType("Enum8('a b' = 1)")).toBe("Enum8('a b'=1)");
    expect(canonicalType("Enum8('a b'=1)")).toBe("Enum8('a b'=1)");
  });

  it('never conflates LowCardinality(T) with T, or a different wrapper order with another', () => {
    expect(canonicalType('String')).not.toBe(canonicalType('LowCardinality(String)'));
    expect(canonicalType('Nullable(String)')).not.toBe(canonicalType('LowCardinality(Nullable(String))'));
    expect(canonicalType('LowCardinality(Nullable(String))')).not.toBe(canonicalType('Nullable(LowCardinality(String))'));
  });

  it('accepts a parsed node (uses its .raw) as well as a raw string', () => {
    expect(canonicalType(parseClickHouseType('Array( String )'))).toBe('Array(String)');
  });

  it('is deterministic', () => {
    expect(canonicalType('Map( String , UInt8 )')).toBe(canonicalType('Map(String,UInt8)'));
  });
});
