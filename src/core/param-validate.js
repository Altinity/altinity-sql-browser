// Pure, permissive validation of a variable's entered value against its
// declared `{name:Type}` (#170) — plugged into #173's pipeline as its
// validation stage (see `param-pipeline.js`'s `validateParamValue` seam).
//
// Guiding principle: only reject what ClickHouse's **param** value path will
// certainly reject. That path is the type's text *deserialization* (TSV-field
// -like), not the SQL literal grammar — so SQL-side forms (hex, underscores,
// unary `+`) can be, and are, rejected here even though they're legal SQL
// literals. Anything this module doesn't cover returns `'unknown'`, which the
// pipeline treats as pass-through (today's behavior, unchanged) — a false
// "invalid" that blocks a value the server would accept is worse than no
// validation at all.
//
// Every family's accept/reject grammar below was verified against a live
// ClickHouse 26.3.13 server via the real `param_*` HTTP path (not guessed
// from SQL syntax) — see the per-family comments for exactly which facts
// shaped which decision.
//
// `validateParamValue(type, value) → { status, reason? }`:
//   - `'valid'`      — accepted as-is.
//   - `'invalid'`    — certainly rejected (or, for Int/UInt only, silently
//                      wrapped by the server — see the range-check note
//                      below); `reason` is a specific, actionable message —
//                      for Int/UInt, a syntax failure ('abc', '+5', '007')
//                      gets a distinct, syntax-shaped reason from a range
//                      failure ('256', '-129'), so the two don't read as the
//                      same complaint (#170 review).
//   - `'incomplete'` — a plausible mid-typing prefix (`'-'`, `'1e'`, a half
//                      UUID): neutral while the field is focused, hardens to
//                      `'invalid'` on blur/Enter/execute (the pipeline, not
//                      this module, does that hardening — see
//                      `param-pipeline.js`).
//   - `'unknown'`    — type not covered, or an empty value (emptiness is the
//                      gate's business, never this module's) — passthrough.
//
// `type` may be a raw declaration string or an already-`parseParamType`d
// shape (same convention as `param-serialize.js`); `Nullable(T)` unwraps for
// free since `parseParamType` already flattens it to `T`'s shape.

import { parseParamType, enumMembers } from './param-type.js';

const INT_UINT = /^(U?)Int(8|16|32|64|128|256)$/;

// ── Int / UInt ───────────────────────────────────────────────────────────
// Live-server facts: plain digits only. Leading `+` REJECTED (`+5`, `+42`).
// Hex (`0x1F`), underscores (`1_0`), exponents (`1e2`), decimals (`5.0`),
// surrounding whitespace, and leading zeros (`007`, `00`) are all REJECTED.
// `0` and `-0` are accepted for Int. UInt never accepts a leading `-`
// (`-1` REJECTED) whatever digits follow.
const INT_FULL = /^-?(0|[1-9]\d*)$/;
const UINT_FULL = /^(0|[1-9]\d*)$/;

/** The live-verified signed-integer token grammar (incl. the `-0` allowance,
 *  excl. leading zeros) — exported for `param-serialize.js`'s array-element
 *  tokens, so the serializer and this validator never diverge on what an
 *  integer looks like (review F7: the serializer used to accept `007`, which
 *  this grammar — and the server — rejects). */
export const INT_TOKEN = INT_FULL;

function intBounds(signed, bits) {
  const width = BigInt(bits);
  const max = signed ? (2n ** (width - 1n)) - 1n : (2n ** width) - 1n;
  const min = signed ? -(2n ** (width - 1n)) : 0n;
  return { min, max };
}

function validateIntUint(signed, bits, base, value) {
  const { min, max } = intBounds(signed, bits);
  const full = signed ? INT_FULL : UINT_FULL;
  const rangeReason = `Expected ${base} from ${min} to ${max}`;
  if (full.test(value)) {
    const n = BigInt(value);
    // CRITICAL NUANCE (live-verified): an out-of-range value is ACCEPTED by
    // the server and silently WRAPS (`256` → `0` for UInt8, `128` → `-128`
    // for Int8) rather than erroring. This range check deliberately EXCEEDS
    // server strictness — it blocks a value the server would silently
    // corrupt into a different number, which the acceptance criteria call
    // out explicitly (#170).
    if (n < min || n > max) return { status: 'invalid', reason: rangeReason };
    return { status: 'valid' };
  }
  // A lone sign is the one genuinely ambiguous typing prefix here — for Int
  // it may still become a valid negative number; for UInt it never can (a
  // leading '-' is unconditionally rejected), but showing red on the very
  // first keystroke is worse UX than a neutral wait for the next character,
  // and it hardens to invalid on blur/Enter/execute either way. Every other
  // rejection (leading zero, letters, punctuation) can never become valid by
  // appending more characters, so it's invalid immediately — no separate
  // "incomplete" state needed for those (unlike Float/UUID below, digits
  // don't grow into something newly-invalid the way a lone '-' can resolve).
  if (value === '-') return { status: 'incomplete' };
  // A UInt value that's otherwise a well-formed *signed* integer (e.g. '-1')
  // is numerically out of range (below 0), not a syntax problem — keep the
  // range-shaped reason so "-1 for a UInt8" reads as "too low", matching the
  // in-range/out-of-range framing above, not "not a number".
  if (!signed && INT_FULL.test(value)) return { status: 'invalid', reason: rangeReason };
  // Everything else here (letters, decimals, exponents, a leading '+',
  // leading zeros, underscores, hex, whitespace) can never become valid by
  // appending more characters — it's a syntax failure, not a range one, so it
  // gets a distinct, syntax-shaped reason (#170 review) rather than reusing
  // the range message, which would misleadingly suggest '256' and 'abc' failed
  // for the same reason.
  return {
    status: 'invalid',
    reason: signed
      ? 'Expected a whole number (digits only)'
      : 'Expected a whole number (digits only, no minus sign)',
  };
}

// ── Float32 / Float64 ────────────────────────────────────────────────────
// Live-server facts: accepted — `1.5`, `-2e-3`, `1E5`, `.5`, `5.`,
// `inf`/`Infinity`/`+inf`/`INF`/`iNf` (case-insensitive), `nan`/`NaN`/`-nan`,
// and even a bare exponent `e5` (parses as 0). Rejected — `12,5`, `1e` (a
// marker with no exponent digits), hex float `0x1p3`. No range check: a
// Float32 overflow (`3.4e40`) is accepted (saturates to inf).
const FLOAT_LITERAL = /^[+-]?(infinity|inf|nan)$/i;
// Mantissa + optional exponent, OR a bare exponent with no mantissa at all
// (the `e5` → 0 case above).
const FLOAT_FULL = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[eE][+-]?\d+)$/;
// Prefixes still "on track": a lone sign, a lone '.', or a mantissa (or
// nothing) followed by a bare exponent marker with no digits yet ('1e',
// '1e-', 'e', 'e+'). These are all REJECTED as final values (`1e` above) but
// are genuine mid-typing states — neutral until they harden.
const FLOAT_INCOMPLETE = /^[+-]?(?:\.|(?:\d+\.?\d*|\.\d+)?[eE][+-]?)?$/;

/** The live-verified Float accept set as one predicate — mantissa/exponent
 *  forms plus `inf`/`infinity`/`nan` (case-insensitive, optionally signed) —
 *  exported for `param-serialize.js`'s array-element tokens (review F7), the
 *  same single-source-of-truth arrangement as `INT_TOKEN` above. */
export const isValidFloatToken = (s) => FLOAT_LITERAL.test(s) || FLOAT_FULL.test(s);

// A letters-only prefix of 'infinity' or 'nan' (optionally signed) — 'i',
// 'in', 'n', 'na', any case. Requires at least one letter so it never
// overlaps FLOAT_INCOMPLETE's sign-only/empty match (kept as a separate,
// disjoint check rather than folded in, so every branch here is reachable).
function floatWordPrefix(value) {
  const m = /^[+-]?([A-Za-z]+)$/.exec(value);
  if (!m) return false;
  const body = m[1].toLowerCase();
  return 'infinity'.startsWith(body) || 'nan'.startsWith(body);
}

function validateFloat(base, value) {
  if (FLOAT_LITERAL.test(value) || FLOAT_FULL.test(value)) return { status: 'valid' };
  if (FLOAT_INCOMPLETE.test(value) || floatWordPrefix(value)) return { status: 'incomplete' };
  return { status: 'invalid', reason: `Expected a ${base} number (e.g. 1.5, -2e-3, inf, nan)` };
}

// ── Bool ─────────────────────────────────────────────────────────────────
// Live-server facts: accepts true/false/1/0/yes/no/on/off/T/Y (any case)
// "AND unpredictably more" (`enable` → true was accepted; `2` was rejected)
// — the accept-set is NOT enumerable. So Bool must NEVER return 'invalid'
// (or 'incomplete', which hardens into invalid): only the forms confirmed
// live are 'valid'; everything else passes through as 'unknown', exactly
// like an uncovered type.
const BOOL_VALID = /^(true|false|1|0|yes|no|on|off|t|y)$/i;

function validateBool(value) {
  return BOOL_VALID.test(value) ? { status: 'valid' } : { status: 'unknown' };
}

// ── UUID ─────────────────────────────────────────────────────────────────
// Live-server facts: standard 8-4-4-4-12 hyphenated hex (any case) accepted;
// 32 hex chars with NO hyphens also accepted; braced form REJECTED; wrong
// length / braces / other punctuation → invalid.
const UUID_HYPHEN_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_FULL = /^[0-9a-f]{32}$/i;
const UUID_HYPHEN_POS = [8, 13, 18, 23];

// Is `value` a prefix that could still grow (by appending characters only)
// into the standard hyphenated form? Every hyphen seen so far must sit at
// exactly one of the canonical positions, and every non-hyphen must be hex —
// a hyphen in the wrong slot, or a hex character sitting where a hyphen was
// already required, can never be fixed by typing further.
function uuidHyphenPrefixOk(value) {
  for (let i = 0; i < value.length; i++) {
    const mustBeHyphen = UUID_HYPHEN_POS.includes(i);
    const ch = value[i];
    if (mustBeHyphen ? ch !== '-' : !/[0-9a-f]/i.test(ch)) return false;
  }
  return true;
}

function validateUuid(value) {
  if (UUID_HYPHEN_FULL.test(value) || UUID_COMPACT_FULL.test(value)) return { status: 'valid' };
  const compactPrefix = value.length < 32 && /^[0-9a-f]*$/i.test(value);
  const hyphenPrefix = value.length < 36 && uuidHyphenPrefixOk(value);
  if (compactPrefix || hyphenPrefix) return { status: 'incomplete' };
  return { status: 'invalid', reason: 'Expected a UUID (8-4-4-4-12 hex, hyphenated or not)' };
}

// ── Enum8 / Enum16 (#172 v1 — declared-type membership) ─────────────────────
// The declared Enum type is authoritative: ClickHouse rejects any string that
// isn't one of its member names. LIVE-SERVER FACT (ClickHouse 26.3.13): the
// server ALSO accepts a bare numeric code string (`1`) for a declared Enum
// param, binding it as the member with that code — so membership here checks
// BOTH the member names and the integer-string codes. A signed, unpadded
// integer format (no leading zero, no leading `+`) is required for the code
// path — the same literal shape Int/UInt validation above already demands —
// since that's the only form live-verified to bind.
const ENUM_CODE_FORMAT = /^-?(0|[1-9]\d*)$/;

// How many member names the 'invalid' reason samples before summarizing the
// rest as a count — long enough to usually name the value the author meant,
// short enough that the reason stays a one-line tooltip even for a huge Enum16.
const ENUM_REASON_SAMPLE = 8;

function enumReason(members) {
  const shown = members.slice(0, ENUM_REASON_SAMPLE).map((m) => `'${m.name}'`).join(', ');
  const rest = members.length > ENUM_REASON_SAMPLE ? `, … (${members.length} total)` : '';
  return `Expected one of: ${shown}${rest}`;
}

function validateEnum(type, value) {
  const members = enumMembers(type);
  // No parseable members (e.g. `Enum8` with a malformed/empty member list) —
  // nothing to check against, so this degrades to the same passthrough an
  // unrecognized type gets.
  if (!members || !members.length) return { status: 'unknown' };
  if (members.some((m) => m.name === value)) return { status: 'valid' };
  if (ENUM_CODE_FORMAT.test(value) && members.some((m) => m.code === Number(value))) {
    return { status: 'valid' };
  }
  // Neutral mid-typing prefixes (#170's timing model — "don't show red on the
  // very first keystroke", hardening to invalid on blur/Enter/execute): a
  // strict prefix of some member's NAME, a lone '-' (could still grow into a
  // negative code), or digits that are a strict prefix of some declared
  // code's string form ('1' on the way to code 12 — mirrors the name-prefix
  // rule; a full number no code can extend, like '3' against codes {1, 2},
  // stays immediately invalid, matching the live-verified server rejection).
  const codePrefix = ENUM_CODE_FORMAT.test(value)
    && members.some((m) => { const s = String(m.code); return s !== value && s.startsWith(value); });
  if (value === '-' || codePrefix || members.some((m) => m.name !== value && m.name.startsWith(value))) {
    return { status: 'incomplete' };
  }
  return { status: 'invalid', reason: enumReason(members) };
}

/**
 * Validate `value` (the field's current text) against its declared parameter
 * `type`. Pure. See the module doc above for the full status contract.
 * @param {string|import('./param-type.js').ParsedParamType} type
 * @param {*} value
 * @returns {{status: 'valid'|'invalid'|'incomplete'|'unknown', reason?: string}}
 */
export function validateParamValue(type, value) {
  // Empty is the gate's business (missing/inactive), never the validator's —
  // an empty value never reaches a per-type check.
  if (value == null || value === '') return { status: 'unknown' };
  const t = typeof type === 'string' ? parseParamType(type) : type;
  const base = t.base;
  const s = typeof value === 'string' ? value : String(value);
  const m = INT_UINT.exec(base);
  if (m) return validateIntUint(m[1] === '', Number(m[2]), base, s);
  if (base === 'Float32' || base === 'Float64') return validateFloat(base, s);
  if (base === 'Bool' || base === 'Boolean') return validateBool(s);
  if (base === 'UUID') return validateUuid(s);
  if (base === 'Enum8' || base === 'Enum16') return validateEnum(t, s);
  // String, Array(…), Map(…), Decimal(…), Date/DateTime, and any unrecognized
  // shape: out of v1 scope (or, for Decimal/Date*, owned by #169) — always
  // pass through. (#172 v2's schema-cache-inferred Enum suggestions never
  // reach here as an Enum — the declared type stays whatever it really is,
  // e.g. String — which is exactly why v2 is suggestion-only, never blocking.)
  return { status: 'unknown' };
}
