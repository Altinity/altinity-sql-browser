import { describe, it, expect } from 'vitest';
import { serializeParamValue } from '../../src/core/param-serialize.js';
import { parseParamType } from '../../src/core/param-type.js';

describe('serializeParamValue — scalar passthrough (byte-identical with today)', () => {
  it('a string value passes through unchanged for any declaration', () => {
    expect(serializeParamValue('default', 'String')).toEqual({ ok: true, value: 'default' });
    expect(serializeParamValue('0', 'UInt8')).toEqual({ ok: true, value: '0' });
    // funny characters stay verbatim — the server parses scalars raw
    expect(serializeParamValue("it's [a] \\test", 'String')).toEqual({ ok: true, value: "it's [a] \\test" });
    // even against an Array declaration: a hand-typed literal keeps working
    expect(serializeParamValue("['a','b']", 'Array(String)')).toEqual({ ok: true, value: "['a','b']" });
  });

  it('big-integer strings are emitted verbatim, never through a JS Number', () => {
    const big = '18446744073709551615'; // UInt64 max > Number.MAX_SAFE_INTEGER
    expect(serializeParamValue(big, 'UInt64')).toEqual({ ok: true, value: big });
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    expect(serializeParamValue(huge, 'UInt256')).toEqual({ ok: true, value: huge });
  });

  it('non-string scalars stringify (number, bigint, boolean)', () => {
    expect(serializeParamValue(42, 'UInt8')).toEqual({ ok: true, value: '42' });
    expect(serializeParamValue(18446744073709551615n, 'UInt64')).toEqual({ ok: true, value: '18446744073709551615' });
    expect(serializeParamValue(true, 'Bool')).toEqual({ ok: true, value: 'true' });
  });

  it('rejects an unsupported value type with a clear error', () => {
    const r = serializeParamValue({ nope: 1 }, 'String', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('{x}');
    expect(serializeParamValue(null, 'String').ok).toBe(false);
    expect(serializeParamValue(undefined, 'String').ok).toBe(false);
  });
});

describe('serializeParamValue — Array(T) literals', () => {
  it('Array(String): quoted elements, comma-joined, no spaces', () => {
    expect(serializeParamValue(['a', 'b'], 'Array(String)')).toEqual({ ok: true, value: "['a','b']" });
  });

  it('empty array → []', () => {
    expect(serializeParamValue([], 'Array(String)')).toEqual({ ok: true, value: '[]' });
    expect(serializeParamValue([], 'Array(UInt64)')).toEqual({ ok: true, value: '[]' });
  });

  it('escapes single quotes and backslashes (live-server verified shape)', () => {
    expect(serializeParamValue(["a'b", 'c\\d'], 'Array(String)'))
      .toEqual({ ok: true, value: "['a\\'b','c\\\\d']" });
    // torture: mixed quotes/backslashes back to back
    expect(serializeParamValue(["\\'", "''", '\\\\'], 'Array(String)'))
      .toEqual({ ok: true, value: "['\\\\\\'','\\'\\'','\\\\\\\\']" });
  });

  it('Array(UInt64): bare integer tokens, big values verbatim as strings', () => {
    expect(serializeParamValue(['1', '18446744073709551615'], 'Array(UInt64)'))
      .toEqual({ ok: true, value: '[1,18446744073709551615]' });
    expect(serializeParamValue([1, 2], 'Array(UInt32)')).toEqual({ ok: true, value: '[1,2]' });
    expect(serializeParamValue(['-5'], 'Array(Int64)')).toEqual({ ok: true, value: '[-5]' });
  });

  it('rejects a non-integer token for an integer element type', () => {
    const r = serializeParamValue(['1', 'abc'], 'Array(UInt64)', 'ids');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('abc');
    expect(r.error).toContain('UInt64');
    // a huge JS number stringifies to exponent form — caught, not emitted
    expect(serializeParamValue([1e21], 'Array(UInt64)').ok).toBe(false);
    // '+' signs are not valid array-literal tokens (server rejects them too)
    expect(serializeParamValue(['+1'], 'Array(UInt64)').ok).toBe(false);
  });

  it('Array(Float64): decimal / exponent tokens allowed, junk rejected', () => {
    expect(serializeParamValue(['1.5', '-2', '.5', '1e-3'], 'Array(Float64)'))
      .toEqual({ ok: true, value: '[1.5,-2,.5,1e-3]' });
    expect(serializeParamValue(['1.2.3'], 'Array(Float64)').ok).toBe(false);
  });

  // Review F7: element tokens follow the VALIDATOR's live-verified scalar
  // grammar (param-validate.js), not a third private copy.
  it('rejects a leading-zero integer element (007) with a clear error — the live-verified grammar the scalar path already enforces', () => {
    const r = serializeParamValue(['007'], 'Array(UInt64)', 'ids');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('007');
    expect(r.error).toContain('UInt64');
    expect(serializeParamValue(['00'], 'Array(Int32)').ok).toBe(false);
    // '0' and '-0' stay accepted (the validator's explicit allowance).
    expect(serializeParamValue(['0', '-0'], 'Array(Int32)')).toEqual({ ok: true, value: '[0,-0]' });
  });
  it('accepts inf/nan Float elements case-insensitively, and the validator-verified 5. / +5 / e5 forms', () => {
    expect(serializeParamValue(['inf', '-Infinity', 'NaN'], 'Array(Float64)'))
      .toEqual({ ok: true, value: '[inf,-Infinity,NaN]' });
    expect(serializeParamValue(['5.', '+5', 'e5'], 'Array(Float64)'))
      .toEqual({ ok: true, value: '[5.,+5,e5]' });
    // A bare exponent MARKER (no digits) is still rejected, same as the scalar path.
    expect(serializeParamValue(['1e'], 'Array(Float64)').ok).toBe(false);
  });

  it('Array(Bool): booleans and true/false/1/0 tokens', () => {
    expect(serializeParamValue([true, false], 'Array(Bool)')).toEqual({ ok: true, value: '[true,false]' });
    expect(serializeParamValue(['true', '0'], 'Array(Bool)')).toEqual({ ok: true, value: '[true,0]' });
    expect(serializeParamValue(['yes'], 'Array(Bool)').ok).toBe(false);
  });

  it('Array(UUID) / Array(Date): quoted like text', () => {
    expect(serializeParamValue(['61f0c404-5cb3-11e7-907b-a6006ad3dba0'], 'Array(UUID)'))
      .toEqual({ ok: true, value: "['61f0c404-5cb3-11e7-907b-a6006ad3dba0']" });
    expect(serializeParamValue(['2024-01-01', '2024-02-01'], 'Array(Date)'))
      .toEqual({ ok: true, value: "['2024-01-01','2024-02-01']" });
  });

  it('a bare Array declaration (no element type) quotes elements as text', () => {
    expect(serializeParamValue(['a'], 'Array')).toEqual({ ok: true, value: "['a']" });
  });

  it('accepts a pre-parsed type object', () => {
    expect(serializeParamValue(['a'], parseParamType('Array(String)'))).toEqual({ ok: true, value: "['a']" });
  });
});

describe('serializeParamValue — rejections', () => {
  it('array value against a scalar declaration is a structural error', () => {
    const r = serializeParamValue(['a'], 'String', 'db');
    expect(r.ok).toBe(false);
    expect(r.structural).toBe(true);
    expect(r.error).toContain('{db}');
    expect(r.error).toContain('String');
  });

  it('NULL elements are rejected in v1, even under Array(Nullable(T))', () => {
    const r = serializeParamValue(['a', null], 'Array(Nullable(String))', 'xs');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('NULL');
    expect(serializeParamValue([undefined], 'Array(String)').ok).toBe(false);
  });

  it('nested arrays are rejected with a clear error (declaration and value)', () => {
    const decl = serializeParamValue([[1, 2]], 'Array(Array(UInt8))', 'm');
    expect(decl.ok).toBe(false);
    expect(decl.error).toContain('nested Array');
    const val = serializeParamValue([['a']], 'Array(String)', 'm');
    expect(val.ok).toBe(false);
    expect(val.error).toContain('nested array value');
  });

  it('object elements are rejected', () => {
    expect(serializeParamValue([{ a: 1 }], 'Array(String)').ok).toBe(false);
  });
});
