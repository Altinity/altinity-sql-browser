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
    for (const value of ['', 'Array(', 'Array(String))', 'Map(String)', 'Tuple(name String, UInt8)']) {
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
});
