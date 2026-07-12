import { describe, it, expect } from 'vitest';
import { compactType } from '../../src/core/type-display.js';

// A budget small enough that every non-trivial fixture must compact, but large
// enough that the compacted summaries fit without generic truncation.
const MAX = 30;

describe('compactType — short types pass through unchanged', () => {
  it.each([
    'UInt64',
    'DateTime64(3)',
    "DateTime64(3, 'UTC')",
    'LowCardinality(String)',
    'Array(UInt32)',
    'Map(String, UInt64)',
    'Tuple(UInt64, String)',
    "Enum8('a'=1,'b'=2)",
  ])('%s', (t) => {
    expect(compactType(t, MAX)).toBe(t);
  });

  it('returns a string exactly at maxLen unchanged', () => {
    const t = 'DateTime64(3)';
    expect(compactType(t, t.length)).toBe(t);
  });
});

describe('compactType — collapses unbounded declarations', () => {
  it('Enum8 → exact value count', () => {
    expect(compactType("Enum8('alpha' = 1, 'beta' = 2, 'gamma' = 3)", MAX)).toBe('Enum8(3 values)');
  });

  it('Enum16 → exact value count', () => {
    expect(compactType("Enum16('Close' = -11, 'Error' = -1, 'Watch' = 0, 'Created' = 1)", MAX))
      .toBe('Enum16(4 values)');
  });

  it('Tuple → field count (named fields)', () => {
    expect(compactType('Tuple(a UInt64, b String, c DateTime, d Float64, e IPv4)', MAX))
      .toBe('Tuple(5 fields)');
  });

  it('Nested → field count', () => {
    expect(compactType('Nested(id UInt64, value String, created_at DateTime, flag UInt8)', MAX))
      .toBe('Nested(4 fields)');
  });

  it('Variant → type count', () => {
    expect(compactType('Variant(String, UInt64, DateTime, Array(String))', MAX))
      .toBe('Variant(4 types)');
  });

  it('AggregateFunction → function name + arg count', () => {
    expect(compactType('AggregateFunction(quantiles(0.5, 0.9, 0.99), UInt64)', 40))
      .toBe('AggregateFunction(quantiles, 1 arg)');
  });

  it('AggregateFunction pluralizes multiple args and keeps array-literal params as one entry', () => {
    expect(compactType('AggregateFunction(sumMapFiltered([1, 2]), Array(UInt8), Array(UInt64))', 45))
      .toBe('AggregateFunction(sumMapFiltered, 2 args)');
  });

  it('SimpleAggregateFunction → function name + arg count', () => {
    expect(compactType('SimpleAggregateFunction(groupArrayArray, Array(String))', 50))
      .toBe('SimpleAggregateFunction(groupArrayArray, 1 arg)');
  });

  it('JSON with parameters → JSON(configured)', () => {
    expect(compactType('JSON(max_dynamic_paths=1024, SKIP old_path, SKIP other.path)', MAX))
      .toBe('JSON(configured)');
  });

  it('JSON parameters may carry nested braces', () => {
    expect(compactType('JSON(max_dynamic_paths=1024, typed_paths={a: 1}, SKIP old_path)', MAX))
      .toBe('JSON(configured)');
  });
});

describe('compactType — preserves outer wrappers', () => {
  it('Nullable(Enum16(…))', () => {
    expect(compactType("Nullable(Enum16('alpha' = -1, 'beta' = 0, 'gamma' = 1))", MAX))
      .toBe('Nullable(Enum16(3 values))');
  });

  it('Array(Enum8(…))', () => {
    expect(compactType("Array(Enum8('alpha' = 1, 'beta' = 2, 'gamma' = 3))", MAX))
      .toBe('Array(Enum8(3 values))');
  });

  it('Array(Tuple(…))', () => {
    expect(compactType('Array(Tuple(a UInt64, b String, c DateTime, d Float32))', MAX))
      .toBe('Array(Tuple(4 fields))');
  });

  it('Map(String, Enum16(…)) — non-collapsed sibling args kept', () => {
    expect(compactType("Map(String, Enum16('alpha' = 1, 'beta' = 2))", MAX))
      .toBe('Map(String, Enum16(2 values))');
  });

  it('Map(String, Variant(…))', () => {
    expect(compactType('Map(String, Variant(UInt64, String, DateTime, IPv4, IPv6))', MAX))
      .toBe('Map(String, Variant(5 types))');
  });

  it('LowCardinality(Tuple(…))', () => {
    expect(compactType('LowCardinality(Tuple(a UInt64, b String, c DateTime, d Date))', 35))
      .toBe('LowCardinality(Tuple(4 fields))');
  });

  it('keeps an unrecognized parameterized type inside a wrapper verbatim', () => {
    expect(compactType("Map(DateTime64(3, 'UTC'), Enum8('aaaa' = 1, 'bbbb' = 2, 'cccc' = 3))", 45))
      .toBe("Map(DateTime64(3, 'UTC'), Enum8(3 values))");
  });

  it('wrapper nesting within the depth cap compacts normally', () => {
    expect(compactType('Array(Array(Array(Nullable(Tuple(a UInt64, b String, c Date)))))', 50))
      .toBe('Array(Array(Array(Nullable(Tuple(3 fields)))))');
  });
});

describe('compactType — difficult lexical cases', () => {
  it('doubled-quote escape inside a member name', () => {
    expect(compactType("Enum8('a''b' = 1, 'x(y)' = 2, 'longer name here' = 3)", MAX))
      .toBe('Enum8(3 values)');
  });

  it('backslash escape inside a member name', () => {
    expect(compactType("Enum8('a\\'b' = 1, 'c' = 2, 'a very long member name' = 3)", MAX))
      .toBe('Enum8(3 values)');
  });

  it('parens and commas inside quoted member names do not split entries', () => {
    expect(compactType("Tuple(name Enum8(')' = 1, ',' = 2), other String, third UInt64)", MAX))
      .toBe('Tuple(3 fields)');
  });

  it('backtick-quoted field names may carry commas, parens, and doubled backticks', () => {
    expect(compactType('Tuple(`a,b` UInt8, `c)d` String, `e``f` DateTime, g Float64)', MAX))
      .toBe('Tuple(4 fields)');
  });

  it('double-quoted field names may carry commas', () => {
    expect(compactType('Tuple("a,b" UInt8, c String, d DateTime, e Float64, f IPv4)', MAX))
      .toBe('Tuple(5 fields)');
  });

  it('singularizes a count of exactly 1', () => {
    expect(compactType("Enum8('a single very long member name indeed' = 1)", MAX))
      .toBe('Enum8(1 value)');
    expect(compactType('Tuple(one_field_with_a_really_long_name DateTime64(3))', MAX))
      .toBe('Tuple(1 field)');
  });

  it('nested tuples count only top-level fields', () => {
    expect(compactType('Tuple(a String, b Tuple(c UInt64, d String), e DateTime, f Date)', MAX))
      .toBe('Tuple(4 fields)');
  });

  it('tabs and newlines around entries are trimmed, not counted', () => {
    expect(compactType('Tuple(a UInt64,\n\tb String,\r c Date, d Float64, e IPv4, f IPv6)', MAX))
      .toBe('Tuple(6 fields)');
  });

  it('trailing whitespace inside a wrapper argument is trimmed', () => {
    expect(compactType("Nullable( Enum8('aaaa' = 1, 'bbbb' = 2, 'cccc' = 3) )", 26))
      .toBe('Nullable(Enum8(3 values))');
  });
});

describe('compactType — malformed and edge input', () => {
  it('empty input', () => {
    expect(compactType('', 10)).toBe('');
  });

  it('nullish input', () => {
    expect(compactType(null, 10)).toBe('');
    expect(compactType(undefined, 10)).toBe('');
  });

  it('a long bare type name is generically truncated', () => {
    expect(compactType('SomeExoticVeryLongTypeName', 10)).toBe('SomeExoti…');
  });

  it('unbalanced parens on a collapse head → generic count form', () => {
    expect(compactType("Enum16('Close' = -11, 'Error' = -1, 'Watch' = 0", MAX))
      .toBe('Enum16(… values)');
    expect(compactType('Tuple(a UInt64, b String, c DateTime, d Float64', MAX))
      .toBe('Tuple(… fields)');
  });

  it('unterminated quoted string inside a collapse head → generic count form', () => {
    expect(compactType("Enum8('a' = 1, 'unterminated member name goes on", MAX))
      .toBe('Enum8(… values)');
    expect(compactType('Tuple(`unterminated backtick name that goes on and on', MAX))
      .toBe('Tuple(… fields)');
  });

  it('a stray closing bracket where the body should close → generic count form', () => {
    expect(compactType('Tuple(a UInt64, b String, c DateTime] more junk here', MAX))
      .toBe('Tuple(… fields)');
  });

  it('blank entry between commas → generic count form (count not confident)', () => {
    expect(compactType("Enum8('a' = 1,, 'b' = 2, 'ccccccccccccccccccc' = 3)", MAX))
      .toBe('Enum8(… values)');
  });

  it('unbalanced parens on a wrapper head → generic truncation of the raw string', () => {
    expect(compactType("Nullable(Enum8('a' = 1, 'bbbbbbbbbbbbbbbbbbbbbbbb' = 2", 20))
      .toBe("Nullable(Enum8('a' …");
  });

  it('trailing garbage after a balanced declaration → generic truncation', () => {
    expect(compactType("Enum8('a' = 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb' = 2)garbage", 20))
      .toBe("Enum8('a' = 1, 'bbb…");
  });

  it('input starting with a non-identifier → generic truncation', () => {
    expect(compactType("('not' = 1, 'a type at all but very long indeed')", 16))
      .toBe("('not' = 1, 'a …");
  });

  it('unexpected token after the head → generic truncation', () => {
    expect(compactType("Enum8 'a' = 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' = 2", 16))
      .toBe("Enum8 'a' = 1, …");
  });

  it('quoted string where a wrapper argument type should be → generic truncation', () => {
    expect(compactType("Array('just a very long quoted string, not a type at all')", 16))
      .toBe("Array('just a v…");
  });

  it('blank wrapper argument → generic truncation', () => {
    expect(compactType('Map(String,                                              )', 16))
      .toBe('Map(String,    …');
  });

  it('aggregate head with a non-identifier first entry → generic truncation', () => {
    expect(compactType("AggregateFunction('quoted', UInt64, String, DateTime, Date)", 16))
      .toBe('AggregateFuncti…');
  });

  it('empty declaration body counts as 0', () => {
    expect(compactType('Tuple()', 6)).toBe('Tuple…'); // 'Tuple(0 fields)' still over budget → truncated
    expect(compactType('Tuple()', 15)).toBe('Tuple()'); // fits → unchanged, never compacted
  });

  it('very small maxLen truncates the compacted form', () => {
    expect(compactType("Enum16('Close' = -11, 'Error' = -1, 'Watch' = 0, 'x' = 1)", 10))
      .toBe('Enum16(4 …');
    expect(compactType('Tuple(a UInt64, b String, c DateTime, d Float64, e IPv4)', 0)).toBe('…');
  });

  it('compacted output still exceeding maxLen falls back to truncation', () => {
    expect(compactType('SimpleAggregateFunction(groupArrayArray, Array(String))', 20))
      .toBe('SimpleAggregateFunc…');
  });

  it('deeply nested wrappers beyond the depth cap → generic truncation', () => {
    const deep = 'Array('.repeat(12) + 'String' + ')'.repeat(12);
    expect(compactType(deep, 20)).toBe(deep.slice(0, 19) + '…');
  });
});
