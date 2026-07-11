import { describe, it, expect } from 'vitest';
import { validateParamValue } from '../../src/core/param-validate.js';
import { parseParamType } from '../../src/core/param-type.js';

const valid = (t, v) => expect(validateParamValue(t, v)).toEqual({ status: 'valid' });
const unknown = (t, v) => expect(validateParamValue(t, v)).toEqual({ status: 'unknown' });
const incomplete = (t, v) => expect(validateParamValue(t, v)).toEqual({ status: 'incomplete' });
const invalid = (t, v, reason) => {
  const r = validateParamValue(t, v);
  expect(r.status).toBe('invalid');
  if (reason != null) expect(r.reason).toBe(reason);
  else expect(r.reason).toEqual(expect.any(String));
};

describe('validateParamValue: emptiness and unknown types', () => {
  it('never validates an empty value, whatever the type', () => {
    unknown('UInt8', '');
    unknown('UInt8', null);
    unknown('UInt8', undefined);
  });
  it('always unknown for out-of-scope families (v1 scope + #169 deferral) — Enum is now #172-validated below', () => {
    for (const t of ['String', 'Array(String)', 'Map(String, UInt8)', 'Decimal(10, 2)', 'Date', 'DateTime', 'IPv4', 'Whatever']) {
      unknown(t, 'x');
    }
  });
  it('accepts an already-parsed type object, not just a raw string', () => {
    valid(parseParamType('UInt8'), '255');
  });
});

describe('validateParamValue: Int/UInt — range-checked via BigInt', () => {
  it('accepts plain digits within range; rejects out-of-range with a specific reason', () => {
    valid('UInt8', '0');
    valid('UInt8', '255');
    invalid('UInt8', '256', 'Expected UInt8 from 0 to 255');
    invalid('UInt8', '-1', 'Expected UInt8 from 0 to 255'); // leading '-' rejected outright for UInt
  });
  it('Int8 boundaries, including -0', () => {
    valid('Int8', '-128');
    valid('Int8', '127');
    valid('Int8', '-0');
    invalid('Int8', '-129', 'Expected Int8 from -128 to 127');
    invalid('Int8', '128', 'Expected Int8 from -128 to 127');
  });
  it('big widths use BigInt arithmetic — no float precision traps', () => {
    valid('Int64', '-9223372036854775808');
    valid('Int64', '9223372036854775807');
    invalid('Int64', '9223372036854775808', 'Expected Int64 from -9223372036854775808 to 9223372036854775807');
    valid('UInt64', '18446744073709551615');
    invalid('UInt64', '18446744073709551616');
    valid('Int128', '-170141183460469231731687303715884105728');
    valid('UInt256', '0');
    invalid('Int256', 'x');
  });
  it('rejects SQL-literal forms the param path does not accept, with a syntax-shaped reason (#170 review)', () => {
    for (const v of ['+5', '+42', '0x1F', '1_0', '1e2', '5.0', ' 5', '5 ', '007', '00']) {
      invalid('UInt32', v, 'Expected a whole number (digits only, no minus sign)');
      invalid('Int32', v, 'Expected a whole number (digits only)');
    }
  });
  it("a lone '-' is incomplete (neutral while typing) for both Int and UInt", () => {
    incomplete('Int32', '-');
    incomplete('UInt32', '-'); // never becomes valid, but neutral until it hardens
  });
  it('non-digit garbage is invalid outright, not incomplete, with the syntax-shaped reason', () => {
    invalid('UInt32', 'abc', 'Expected a whole number (digits only, no minus sign)');
    invalid('Int32', 'abc', 'Expected a whole number (digits only)');
  });
  it("a negative value for a UInt is a range violation, not a syntax one — keeps the range-shaped reason (#170 review)", () => {
    invalid('UInt8', '-1', 'Expected UInt8 from 0 to 255');
    invalid('UInt32', '-42', 'Expected UInt32 from 0 to 4294967295');
  });
});

describe('validateParamValue: Float32/Float64', () => {
  it('accepts the live-verified forms', () => {
    for (const v of ['1.5', '-2e-3', '1E5', '.5', '5.', '5', '-5', '+2']) valid('Float64', v);
  });
  it('accepts a bare exponent (parses as 0 on the live server)', () => {
    valid('Float64', 'e5');
  });
  it('accepts inf/nan literals, case-insensitive, with sign variants', () => {
    for (const v of ['inf', 'Infinity', '+inf', 'INF', 'iNf', 'infinity', 'nan', 'NaN', '-nan']) valid('Float32', v);
  });
  it('rejects comma decimals and hex float — not plausible typing prefixes', () => {
    invalid('Float64', '12,5', 'Expected a Float64 number (e.g. 1.5, -2e-3, inf, nan)');
    invalid('Float64', '0x1p3');
  });
  it("a bare exponent marker with no digits ('1e') is a live-rejected value but a genuine mid-typing state — incomplete, not invalid", () => {
    for (const v of ['-', '+', '.', '1e', '1e-', '1E+', 'e', 'e-']) incomplete('Float64', v);
  });
  it('treats a partial inf/nan word as incomplete, case-insensitive, optionally signed', () => {
    for (const v of ['i', 'in', 'infini', 'n', 'na', 'I', 'NA', '-n', '+i']) incomplete('Float64', v);
  });
  it('a mismatched letters-only prefix (not on track for inf/nan) is invalid', () => {
    invalid('Float64', 'xyz');
  });
});

describe('validateParamValue: Bool never returns invalid', () => {
  it('recognizes the confirmed accept-set, any case', () => {
    for (const v of ['true', 'FALSE', '1', '0', 'Yes', 'no', 'ON', 'off', 'T', 'y']) valid('Bool', v);
  });
  it('anything unrecognized is unknown, never invalid — the accept-set is not enumerable', () => {
    unknown('Bool', 'enable'); // live-accepted by the server, but not in our confirmed set
    unknown('Bool', '2'); // live-rejected by the server, but we still never say invalid
    unknown('Bool', 'maybe');
  });
});

describe('validateParamValue: UUID', () => {
  it('accepts standard hyphenated form, any case', () => {
    valid('UUID', '123e4567-e89b-12d3-a456-426614174000');
    valid('UUID', '123E4567-E89B-12D3-A456-426614174000');
  });
  it('accepts the 32-hex compact form (no hyphens)', () => {
    valid('UUID', '123e4567e89b12d3a456426614174000');
  });
  it('rejects braces and lengths no further typing could ever fix', () => {
    invalid('UUID', '{123e4567-e89b-12d3-a456-426614174000}');
    invalid('UUID', '123e4567-e89b-12d3-a456-4266141740001'); // 37 chars: one past the hyphenated max
    invalid('UUID', '123e4567e89b12d3a4564266141740001'); // 33 hex chars: one past the compact max
  });
  it('rejects other punctuation', () => {
    invalid('UUID', '123e4567_e89b_12d3_a456_426614174000');
  });
  it('a length one short of either valid form is still a growing prefix → incomplete', () => {
    incomplete('UUID', '123e4567-e89b-12d3-a456-42661417400'); // 35 chars, correctly hyphenated so far
    incomplete('UUID', '123e4567e89b12d3a45642661417400'); // 31 hex chars, no hyphens
  });
  it('treats a growing hex prefix (either shape) as incomplete', () => {
    incomplete('UUID', '123e4567');
    incomplete('UUID', '123e4567-e89b');
    incomplete('UUID', '123e4567e89b12'); // could still grow into the 32-hex compact form
  });
  it('a hyphen in the wrong slot, or a hex run past a mandatory hyphen slot, is unfixable → invalid', () => {
    invalid('UUID', '123-4567e89b12d3a456426614174000'); // hyphen at the wrong position
    invalid('UUID', '1234567890e89b12d3a456426614174000'); // 35 hex chars, no hyphens: past slot 8 too
  });
});

describe('validateParamValue: Nullable(T) unwraps to validate against T', () => {
  it('validates the inner type', () => {
    valid('Nullable(UInt8)', '255');
    invalid('Nullable(UInt8)', '256');
    incomplete('Nullable(Int32)', '-');
    unknown('Nullable(String)', 'anything');
  });
});

// #172 v1 — the declared Enum type is authoritative membership, blocking.
describe('validateParamValue: Enum8/Enum16 (#172 v1, declared-type membership)', () => {
  const ENUM = "Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)";
  it('a member name is valid', () => {
    valid(ENUM, 'active');
    valid(ENUM, 'banned');
  });
  it('a LIVE-VERIFIED bare numeric code string matching a declared code is also valid', () => {
    valid(ENUM, '1');
    valid(ENUM, '3');
  });
  it('a numeric string that matches no declared code is invalid, with a specific reason', () => {
    invalid(ENUM, '4', "Expected one of: 'active', 'deleted', 'banned'");
  });
  it('a non-member, non-code string is invalid with the same sampled reason', () => {
    invalid(ENUM, 'ACTIVE'); // case-sensitive: not an exact member match
    invalid(ENUM, 'unknown-status', "Expected one of: 'active', 'deleted', 'banned'");
  });
  it('a numeric syntax the int validator would reject (leading zero, leading +) is invalid, not treated as a code', () => {
    invalid(ENUM, '007');
    invalid(ENUM, '+1');
  });
  it('a proper prefix of a member name is incomplete (neutral while typing), not invalid', () => {
    incomplete(ENUM, 'a');
    incomplete(ENUM, 'act');
  });
  it('a lone "-" is incomplete (could still grow into a negative code)', () => {
    incomplete("Enum8('neg' = -5)", '-');
  });
  it('Enum16 validates identically to Enum8', () => {
    valid("Enum16('a' = 1, 'b' = 2)", 'a');
    valid("Enum16('a' = 1, 'b' = 2)", '2');
    invalid("Enum16('a' = 1, 'b' = 2)", 'c');
  });
  it('Nullable(Enum8(...)) unwraps and validates the same as the bare Enum', () => {
    valid('Nullable(' + ENUM + ')', 'active');
    invalid('Nullable(' + ENUM + ')', 'nope');
  });
  it('a huge Enum caps the reason to a sample plus a total count', () => {
    const members = Array.from({ length: 12 }, (_, i) => `'m${i}' = ${i}`).join(', ');
    const r = validateParamValue(`Enum8(${members})`, 'nope');
    expect(r.status).toBe('invalid');
    expect(r.reason).toMatch(/^Expected one of: 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', … \(12 total\)$/);
  });
  it('an Enum type with no parseable members degrades to unknown passthrough', () => {
    unknown('Enum8', 'anything');
  });
  // Implicit (auto-numbered) members are real members — a mixed declaration
  // must accept them by name AND by their auto-assigned code, never falsely
  // reject a value the server accepts.
  it('an implicit member in a mixed declaration validates by name and by its auto-numbered code', () => {
    valid("Enum8('a' = 1, 'b')", 'b');   // the reported false-reject case
    valid("Enum8('a' = 1, 'b')", '2');   // b's auto-assigned code
    invalid("Enum8('a' = 1, 'b')", '3'); // beyond the auto-numbered range — live-verified server rejection
  });
  it('a fully-implicit declaration enforces membership (blocking), not silent unknown', () => {
    valid("Enum8('hello', 'world')", 'world');
    valid("Enum8('hello', 'world')", '1');
    invalid("Enum8('hello', 'world')", 'nope', "Expected one of: 'hello', 'world'");
  });
  // MINOR-3: digits that are a strict prefix of some declared code's string
  // form are neutral while typing ('1' on the way to code 12), mirroring the
  // member-name prefix rule; a full number no code can extend stays invalid.
  it('a strict numeric prefix of a declared code is incomplete, not a flash of invalid', () => {
    const CODES = "Enum8('x' = 2, 'y' = 12)";
    incomplete(CODES, '1'); // could still become 12
    valid(CODES, '12');
    invalid(CODES, '13');   // no declared code extends it
    invalid(CODES, '3');    // not a code, not a prefix of '2' or '12'
  });
  it('a negative numeric prefix of a negative code is incomplete too', () => {
    incomplete("Enum8('n' = -12)", '-1'); // could still become -12
    invalid("Enum8('n' = -12)", '-13');
  });
});
