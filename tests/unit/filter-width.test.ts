import { describe, it, expect } from 'vitest';
import { filterWidthCategory, filterInputWidthCh } from '../../src/core/filter-width.js';

describe('filterWidthCategory', () => {
  it('classifies Bool/Boolean and the single-byte integers as bool', () => {
    for (const t of ['Bool', 'Boolean', 'Int8', 'UInt8']) {
      expect(filterWidthCategory(t)).toBe('bool');
    }
  });

  it('classifies wider integers, floats, and Decimal as numeric', () => {
    for (const t of ['Int16', 'UInt32', 'Int64', 'UInt128', 'Int256', 'Float32', 'Float64', 'BFloat16', 'Decimal', 'Decimal(10, 2)', 'Decimal64']) {
      expect(filterWidthCategory(t)).toBe('numeric');
    }
  });

  it('classifies Date/Date32 as date', () => {
    expect(filterWidthCategory('Date')).toBe('date');
    expect(filterWidthCategory('Date32')).toBe('date');
  });

  it('classifies DateTime/DateTime64 as datetime, distinct from Date', () => {
    expect(filterWidthCategory('DateTime')).toBe('datetime');
    expect(filterWidthCategory("DateTime64(3)")).toBe('datetime');
  });

  it('classifies String/UUID/FixedString/unrecognized as the generic string fallback', () => {
    for (const t of ['String', 'UUID', 'FixedString(4)', 'IPv4', 'Whatever', 'Array(String)']) {
      expect(filterWidthCategory(t)).toBe('string');
    }
  });

  it('unwraps Nullable/LowCardinality to the effective base, same as parseParamType', () => {
    expect(filterWidthCategory('Nullable(UInt8)')).toBe('bool');
    expect(filterWidthCategory('LowCardinality(Float64)')).toBe('numeric');
    expect(filterWidthCategory('LowCardinality(Nullable(DateTime))')).toBe('datetime');
  });

  it('isEnumLike always wins over the type\'s own base, including for a curated non-Enum type', () => {
    expect(filterWidthCategory('String', true)).toBe('enum');
    expect(filterWidthCategory("Enum8('a' = 1)", true)).toBe('enum');
    expect(filterWidthCategory('UInt8', true)).toBe('enum');
  });

  it('defaults isEnumLike to false when omitted', () => {
    expect(filterWidthCategory('String')).toBe('string');
  });
});

describe('filterInputWidthCh', () => {
  it('maps each category to its stable ch width', () => {
    expect(filterInputWidthCh('UInt8')).toBe(9);
    expect(filterInputWidthCh('Int32')).toBe(13);
    expect(filterInputWidthCh('Date')).toBe(13);
    expect(filterInputWidthCh('DateTime64(3)')).toBe(17);
    expect(filterInputWidthCh('String', true)).toBe(14);
    expect(filterInputWidthCh('String')).toBe(16);
    expect(filterInputWidthCh('UUID')).toBe(16);
  });
});
