import { describe, expect, it } from 'vitest';
import {
  arrayElement, isSupportedOptionScalar, mapTypes, namedTupleMembers,
  parseClickHouseType, unwrapNullable,
} from '../../src/core/clickhouse-type.js';

describe('ClickHouse type parser', () => {
  it('parses nested wrappers, whitespace, numeric args, and named tuples', () => {
    const parsed = parseClickHouseType(' Nullable( Array( Tuple( `label name` String, value Decimal(10, 2) ) ) ) ');
    expect(unwrapNullable(parsed).name).toBe('Array');
    const members = namedTupleMembers(arrayElement(parsed));
    expect(members.map((m) => [m.name, m.type.raw])).toEqual([
      ['label name', 'String'], ['value', 'Decimal(10, 2)'],
    ]);
  });
  it('distinguishes positional tuples and reads maps', () => {
    expect(namedTupleMembers(parseClickHouseType('Tuple(String, UInt64)'))).toBeNull();
    expect(mapTypes(parseClickHouseType('Map(String, Nullable(UInt64))')).map((n) => n.name)).toEqual(['String', 'Nullable']);
  });
  it('rejects malformed and unbalanced input', () => {
    for (const value of ['', 'Array(', 'Array(String))', 'Map(String)', 'Tuple(name String, UInt8)', "Enum8('a' = 1", 'LowCardinality(String, String)']) {
      expect(parseClickHouseType(value)).toBeNull();
    }
  });
  it('classifies supported scalars through Nullable', () => {
    for (const value of ['String', 'FixedString(3)', 'UUID', 'UInt256', 'Int8', 'Decimal(20, 4)', 'Float64', 'Bool', 'Date32', 'DateTime64(3)']) {
      expect(isSupportedOptionScalar(parseClickHouseType(`Nullable(${value})`))).toBe(true);
    }
    expect(isSupportedOptionScalar(parseClickHouseType('Array(String)'))).toBe(false);
    expect(arrayElement(null)).toBeNull();
    expect(mapTypes(null)).toBeNull();
  });
  it("parses Enum8/Enum16's quoted member list as an opaque leaf scalar", () => {
    const enum8 = parseClickHouseType("Enum8('active' = 1, 'deleted' = 2)");
    expect(enum8.name).toBe('Enum8');
    expect(enum8.raw).toBe("Enum8('active' = 1, 'deleted' = 2)");
    expect(isSupportedOptionScalar(enum8)).toBe(true);
    expect(isSupportedOptionScalar(parseClickHouseType("Nullable(Enum16('a' = 1))"))).toBe(true);
    const arrayOfEnum = arrayElement(parseClickHouseType("Array(Enum8('a' = 1, 'b' = 2))"));
    expect(arrayOfEnum.name).toBe('Enum8');
  });
  it('unwraps LowCardinality alongside Nullable, in either nesting order', () => {
    expect(unwrapNullable(parseClickHouseType('LowCardinality(String)')).name).toBe('String');
    expect(isSupportedOptionScalar(parseClickHouseType('LowCardinality(String)'))).toBe(true);
    expect(isSupportedOptionScalar(parseClickHouseType('LowCardinality(Nullable(String))'))).toBe(true);
    expect(isSupportedOptionScalar(parseClickHouseType('Nullable(LowCardinality(String))'))).toBe(true);
  });
});
