import { describe, it, expect } from 'vitest';
import { variableWidthCategory, variableInputWidthCh } from '../../src/core/variable-width.js';

describe('variableWidthCategory', () => {
  it('classifies Bool/Boolean and the single-byte integers as bool', () => {
    for (const t of ['Bool', 'Boolean', 'Int8', 'UInt8']) {
      expect(variableWidthCategory(t)).toBe('bool');
    }
  });

  it('classifies wider integers, floats, and Decimal as numeric', () => {
    for (const t of ['Int16', 'UInt32', 'Int64', 'UInt128', 'Int256', 'Float32', 'Float64', 'BFloat16', 'Decimal', 'Decimal(10, 2)', 'Decimal64']) {
      expect(variableWidthCategory(t)).toBe('numeric');
    }
  });

  it('classifies Date/Date32 as date', () => {
    expect(variableWidthCategory('Date')).toBe('date');
    expect(variableWidthCategory('Date32')).toBe('date');
  });

  it('classifies DateTime/DateTime64 as datetime, distinct from Date', () => {
    expect(variableWidthCategory('DateTime')).toBe('datetime');
    expect(variableWidthCategory("DateTime64(3)")).toBe('datetime');
  });

  it('classifies String/UUID/FixedString/unrecognized as the generic string fallback', () => {
    for (const t of ['String', 'UUID', 'FixedString(4)', 'IPv4', 'Whatever', 'Array(String)']) {
      expect(variableWidthCategory(t)).toBe('string');
    }
  });

  it('unwraps Nullable/LowCardinality to the effective base, same as parseParamType', () => {
    expect(variableWidthCategory('Nullable(UInt8)')).toBe('bool');
    expect(variableWidthCategory('LowCardinality(Float64)')).toBe('numeric');
    expect(variableWidthCategory('LowCardinality(Nullable(DateTime))')).toBe('datetime');
  });

  it('isEnumLike always wins over the type\'s own base, including for a curated non-Enum type', () => {
    expect(variableWidthCategory('String', true)).toBe('enum');
    expect(variableWidthCategory("Enum8('a' = 1)", true)).toBe('enum');
    expect(variableWidthCategory('UInt8', true)).toBe('enum');
  });

  it('defaults isEnumLike to false when omitted', () => {
    expect(variableWidthCategory('String')).toBe('string');
  });
});

describe('variableInputWidthCh', () => {
  it('maps each category to its stable ch width', () => {
    expect(variableInputWidthCh('UInt8')).toBe(9);
    expect(variableInputWidthCh('Int32')).toBe(13);
    expect(variableInputWidthCh('Date')).toBe(13);
    expect(variableInputWidthCh('DateTime64(3)')).toBe(17);
    expect(variableInputWidthCh('String', true)).toBe(14);
    expect(variableInputWidthCh('String')).toBe(16);
    expect(variableInputWidthCh('UUID')).toBe(16);
  });
});
