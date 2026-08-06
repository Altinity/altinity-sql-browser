// Phase 0 / issue #585, plan §17 "Precision corpus" — expected values are
// authored HERE, independently of both adapters (current production
// functions and the official client), so a match never just proves "both
// clients agree with each other" (plan's own objection: "Equal values can't
// prove correctness" — both could share the same bug). Every literal below
// is either a well-known numeric/string boundary (computed by hand / from
// the ClickHouse type documentation) or ClickHouse's own documented exact
// text-serialization rule for `JSONStringsEachRowWithProgress`
// (https://clickhouse.com/docs/interfaces/formats/JSONStringsEachRow).
//
// CORRECTED against a real server (live-precision.test.ts's first-ever run,
// 2026-08-05, against ClickHouse 26.6.2.160 — re-verified 2026-08-06 during
// issue #585 Phase 0's evidence review): the header comment above ORIGINALLY
// claimed "every leaf scalar renders as a JSON string, structure
// (arrays/tuples/maps) keeps normal JSON container syntax" — i.e. that a
// nested container's own JSON encoding independently re-stringifies every
// leaf. That is FALSE for `JSONStringsEachRowWithProgress`/
// `JSONEachRowWithProgress`. What actually happens: each COLUMN's `row.<col>`
// value is wrapped in exactly one JSON string (so the outer value IS a JS
// string), but for Array/Tuple/Map/top-level-Nullable/LowCardinality(Nullable)
// types the CONTENT of that string is ClickHouse's own plain/Pretty-style
// text syntax, not recursive JSON: unquoted numbers, single-quoted strings,
// parens for tuples (named tuples render IDENTICALLY to unnamed ones — the
// field names are NOT reflected in text output), the bare word `NULL` for a
// null value NESTED inside a container, and the small-caps glyph `ᴺᵁᴸᴸ`
// (U+1D3A U+1D41 U+1D38 U+1D38) for a null value at the TOP level of a
// Nullable/LowCardinality(Nullable) column. Verified live (2026-08-06)
// against ClickHouse 24.8.14.39 and 26.6.2.160 alike — same rendering on
// both, so this is a stable format property, not a version quirk. The exact
// digit/character content is preserved bit-for-bit either way (this is a
// SERIALIZATION-FORMAT correction, never a precision-loss finding — see
// `runPrecisionCase`'s corpus-wide pass once these literals are corrected).
// The one genuine partial exception is `json-object` (real ClickHouse `JSON`
// type): its string content IS real recursive JSON, but leaves are STILL not
// independently re-stringified (a leaf number stays a JSON number, e.g.
// `{"a":1}`, not `{"a":"1"}`).

export interface PrecisionCase {
  id: string;
  category: string;
  /** The SQL expression this case selects, aliased `v`. */
  select: string;
  /** ClickHouse type name, for the ADR's compatibility notes. */
  chType: string;
  /** The independently-authored expected STRING value as it must appear in
   *  a `JSONStringsEachRowWithProgress`/`JSONEachRowWithProgress` `row.v`
   *  field, or `null` for a capability-gated case with no fixed expectation
   *  (recorded, never silently skipped). */
  expected: string | null;
  /** True when this case depends on a server capability that may be absent
   *  on an older/OSS/Altinity row (e.g. JSON type, IPv6) — the corpus runner
   *  records an explicit capability-gated omission rather than failing. */
  capabilityGated?: boolean;
  because: string;
}

export const PRECISION_CORPUS: PrecisionCase[] = [
  // ── Unsigned integers ──────────────────────────────────────────────────
  { id: 'uint64-max', category: 'unsigned-integers', select: "CAST('18446744073709551615' AS UInt64) AS v", chType: 'UInt64', expected: '18446744073709551615', because: '2^64-1, the documented UInt64 maximum' },
  { id: 'uint64-above-safe-integer', category: 'unsigned-integers', select: "CAST('9007199254740993' AS UInt64) AS v", chType: 'UInt64', expected: '9007199254740993', because: 'Number.MAX_SAFE_INTEGER + 2 — Number() coercion loses this exact value' },
  { id: 'uint128-max', category: 'unsigned-integers', select: "CAST('340282366920938463463374607431768211455' AS UInt128) AS v", chType: 'UInt128', expected: '340282366920938463463374607431768211455', because: '2^128-1, the documented UInt128 maximum' },
  { id: 'uint256-max', category: 'unsigned-integers', select: "CAST('115792089237316195423570985008687907853269984665640564039457584007913129639935' AS UInt256) AS v", chType: 'UInt256', expected: '115792089237316195423570985008687907853269984665640564039457584007913129639935', because: '2^256-1, the documented UInt256 maximum' },
  // ── Signed integers ────────────────────────────────────────────────────
  { id: 'int64-min', category: 'signed-integers', select: "CAST('-9223372036854775808' AS Int64) AS v", chType: 'Int64', expected: '-9223372036854775808', because: '-2^63, the documented Int64 minimum' },
  { id: 'int64-max', category: 'signed-integers', select: "CAST('9223372036854775807' AS Int64) AS v", chType: 'Int64', expected: '9223372036854775807', because: '2^63-1, the documented Int64 maximum' },
  { id: 'int128-min', category: 'signed-integers', select: "CAST('-170141183460469231731687303715884105728' AS Int128) AS v", chType: 'Int128', expected: '-170141183460469231731687303715884105728', because: '-2^127, the documented Int128 minimum' },
  { id: 'int256-max', category: 'signed-integers', select: "CAST('57896044618658097711785492504343953926634992332820282019728792003956564819967' AS Int256) AS v", chType: 'Int256', expected: '57896044618658097711785492504343953926634992332820282019728792003956564819967', because: '2^255-1, the documented Int256 maximum' },
  // ── Decimals ───────────────────────────────────────────────────────────
  // CORRECTED against a real server by the live precision corpus
  // (live-precision.test.ts, plan §17) — issue #585 Phase 0's
  // support-minimum/live-matrix sub-task. The ORIGINAL literal expectation
  // here ('1.2000') was authored from ClickHouse type documentation without
  // ever running against a real server (exactly the gap plan §17 exists to
  // close): a real server (verified on ClickHouse 26.6.2.160, and confirmed
  // NOT format-specific — identical in TSV/JSON/Pretty/JSONStrings*) trims
  // ALL trailing fractional zeros from a Decimal's text serialization
  // regardless of its declared scale, for EVERY Decimal width (Decimal32
  // through Decimal256, CAST-from-string, a numeric literal, and a real
  // table column all agree) — the declared scale governs internal storage
  // and rounding, not trailing-zero padding in text output. This case still
  // proves what it always meant to (decimal round-trip fidelity survives
  // normalization) — the id and select are kept so it is still the corpus's
  // one case deliberately targeting a value WITH trailing zeros; only the
  // expectation now matches verified reality.
  { id: 'decimal32-trailing-zeros', category: 'decimals', select: "CAST('1.2000' AS Decimal32(4)) AS v", chType: 'Decimal32(4)', expected: '1.2', because: 'ClickHouse trims trailing fractional zeros from Decimal text serialization regardless of declared scale (verified live against 26.6.2.160 in TSV/JSON/Pretty/JSONStrings* alike) — declared scale governs rounding/storage, not zero-padding on output' },
  { id: 'decimal64-negative', category: 'decimals', select: "CAST('-123456789.123456' AS Decimal64(6)) AS v", chType: 'Decimal64(6)', expected: '-123456789.123456', because: 'authored literal, sign + scale preserved' },
  { id: 'decimal128-large', category: 'decimals', select: "CAST('123456789012345678901234.123456789012' AS Decimal128(12)) AS v", chType: 'Decimal128(12)', expected: '123456789012345678901234.123456789012', because: 'authored literal exceeding float64 precision' },
  // CORRECTED against a real server (same live-precision.test.ts run as
  // above): the ORIGINAL literal had 78 integer digits + 40 fractional
  // digits = 118 total, far over Decimal256's documented 76-digit maximum
  // total precision — a real server rejects it outright
  // (Code: 69. ARGUMENT_OUT_OF_BOUND), which would otherwise abort the
  // WHOLE corpus run before any other case's mismatch could even be
  // observed (runPrecisionCase rethrows a non-capability-gated query
  // error). Reduced to 28 integer + 40 fractional = 68 total digits — safely
  // under the 76-digit ceiling — and deliberately ending in a non-zero
  // fractional digit, so this case is unaffected by the trailing-zero
  // trimming documented on decimal32-trailing-zeros above.
  { id: 'decimal256-large', category: 'decimals', select: "CAST('1234567890123456789012345678.1234567890123456789012345678901234567891' AS Decimal256(40)) AS v", chType: 'Decimal256(40)', expected: '1234567890123456789012345678.1234567890123456789012345678901234567891', because: 'authored literal at Decimal256 scale, within its documented 76-digit total-precision ceiling (28 integer + 40 fractional = 68 digits) and verified round-trip-exact live against 26.6.2.160' },
  // ── Dates ──────────────────────────────────────────────────────────────
  { id: 'date-ordinary', category: 'dates', select: "CAST('2024-02-29' AS Date) AS v", chType: 'Date', expected: '2024-02-29', because: 'leap-day literal, ISO date serialization' },
  { id: 'date32-pre-epoch', category: 'dates', select: "CAST('1950-06-15' AS Date32) AS v", chType: 'Date32', expected: '1950-06-15', because: 'Date32 supports pre-1970 dates (documented range from 1900)' },
  // ── Date/time ──────────────────────────────────────────────────────────
  { id: 'datetime-tz', category: 'datetime', select: "toDateTime('2024-06-15 12:34:56', 'UTC') AS v", chType: "DateTime('UTC')", expected: '2024-06-15 12:34:56', because: 'authored wall-clock literal in a fixed named timezone' },
  { id: 'datetime64-fractional-tz', category: 'datetime', select: "toDateTime64('2024-06-15 12:34:56.123456', 6, 'UTC') AS v", chType: "DateTime64(6, 'UTC')", expected: '2024-06-15 12:34:56.123456', because: 'microsecond-precision literal, fixed named timezone' },
  // ── Identifiers/network ────────────────────────────────────────────────
  { id: 'uuid', category: 'identifiers-network', select: "CAST('61f0c404-5cb3-11e7-907b-a6006ad3dba0' AS UUID) AS v", chType: 'UUID', expected: '61f0c404-5cb3-11e7-907b-a6006ad3dba0', because: 'canonical UUID textual form is stable under round-trip' },
  { id: 'ipv4', category: 'identifiers-network', select: "CAST('192.168.1.100' AS IPv4) AS v", chType: 'IPv4', expected: '192.168.1.100', because: 'authored dotted-quad literal' },
  { id: 'ipv6', category: 'identifiers-network', select: "CAST('2001:db8::ff00:42:8329' AS IPv6) AS v", chType: 'IPv6', expected: '2001:db8::ff00:42:8329', because: 'authored compressed-form IPv6 literal, ClickHouse preserves compressed form on output' },
  // ── Enums ──────────────────────────────────────────────────────────────
  { id: 'enum8', category: 'enums', select: "CAST('b' AS Enum8('a' = 1, 'b' = 2)) AS v", chType: "Enum8('a'=1,'b'=2)", expected: 'b', because: 'Enum text form round-trips as its label, not its ordinal' },
  { id: 'enum16', category: 'enums', select: "CAST('y' AS Enum16('x' = 1000, 'y' = 2000)) AS v", chType: "Enum16('x'=1000,'y'=2000)", expected: 'y', because: 'same as Enum8, wider ordinal range' },
  // ── Nullable ───────────────────────────────────────────────────────────
  { id: 'nullable-null', category: 'nullable', select: 'CAST(NULL AS Nullable(Int64)) AS v', chType: 'Nullable(Int64)', expected: 'ᴺᵁᴸᴸ', because: 'CORRECTED (verified live against 24.8.14.39/26.6.2.160): a top-level Nullable NULL is NOT JSON null — JSONStringsEachRowWithProgress renders it as the small-caps glyph "ᴺᵁᴸᴸ" (U+1D3A U+1D41 U+1D38 U+1D38), a plain JS string' },
  { id: 'nullable-nonnull', category: 'nullable', select: 'CAST(9223372036854775807 AS Nullable(Int64)) AS v', chType: 'Nullable(Int64)', expected: '9223372036854775807', because: 'a non-null Nullable(Int64) still stringifies like the base type' },
  // ── Arrays ─────────────────────────────────────────────────────────────
  { id: 'array-large-integers', category: 'arrays', select: "[CAST('18446744073709551615' AS UInt64), CAST('0' AS UInt64)] AS v", chType: 'Array(UInt64)', expected: '[18446744073709551615,0]', because: 'CORRECTED (verified live): array member digits are NOT re-quoted — the array renders in plain/Pretty-style text (unquoted numbers) inside the one JSON string wrapping the whole column; digits are still preserved exactly, just unquoted' },
  { id: 'array-nullable', category: 'arrays', select: "[CAST(1 AS Nullable(Int32)), CAST(NULL AS Nullable(Int32))] AS v", chType: 'Array(Nullable(Int32))', expected: '[1,NULL]', because: 'CORRECTED (verified live): a null nested INSIDE a container renders as the bare word NULL (not JSON null, not the top-level "ᴺᵁᴸᴸ" glyph), and the non-null member is unquoted' },
  // ── Tuples ─────────────────────────────────────────────────────────────
  { id: 'tuple-unnamed-precision', category: 'tuples', select: "(CAST('18446744073709551615' AS UInt64), CAST('-9223372036854775808' AS Int64)) AS v", chType: 'Tuple(UInt64, Int64)', expected: '(18446744073709551615,-9223372036854775808)', because: 'CORRECTED (verified live): an unnamed tuple renders as parens with unquoted/plain-text members, not a JSON array of strings' },
  { id: 'tuple-named-precision', category: 'tuples', select: "CAST((CAST('18446744073709551615' AS UInt64), 'x') AS Tuple(big UInt64, label String)) AS v", chType: 'Tuple(big UInt64, label String)', expected: "(18446744073709551615,'x')", because: "CORRECTED (verified live): a NAMED tuple renders IDENTICALLY to an unnamed one in text output — field names are not reflected at all, and the String member is single-quoted, not a JSON object keyed by field name" },
  // ── Maps ───────────────────────────────────────────────────────────────
  { id: 'map-string-large-integer', category: 'maps', select: "map('k', CAST('18446744073709551615' AS UInt64)) AS v", chType: 'Map(String, UInt64)', expected: "{'k':18446744073709551615}", because: "CORRECTED (verified live): a Map renders with single-quoted string keys and unquoted/plain-text values, not a JSON object with double-quoted string values" },
  { id: 'map-string-date', category: 'maps', select: "map('k', CAST('2024-06-15' AS Date)) AS v", chType: 'Map(String, Date)', expected: "{'k':'2024-06-15'}", because: "CORRECTED (verified live): Map keys AND Date values are both single-quoted plain text, not a JSON object with double-quoted values" },
  // ── LowCardinality ─────────────────────────────────────────────────────
  { id: 'lowcardinality-string', category: 'lowcardinality', select: "CAST('hello' AS LowCardinality(String)) AS v", chType: 'LowCardinality(String)', expected: 'hello', because: 'LowCardinality is transparent to text serialization' },
  { id: 'lowcardinality-nullable-string', category: 'lowcardinality', select: 'CAST(NULL AS LowCardinality(Nullable(String))) AS v', chType: 'LowCardinality(Nullable(String))', expected: 'ᴺᵁᴸᴸ', because: 'CORRECTED (verified live): same top-level-Nullable rule as nullable-null above — LowCardinality is transparent, so this is still the "ᴺᵁᴸᴸ" glyph, not JSON null' },
  // ── JSON/Object (capability-gated) ─────────────────────────────────────
  { id: 'json-object', category: 'json-object', select: "'{\"a\":1}'::JSON AS v", chType: 'JSON', expected: '{"a":1}', capabilityGated: true, because: 'CORRECTED (verified live): the real ClickHouse JSON type\'s string content IS recursive JSON syntax (unlike Array/Tuple/Map above), but leaf scalars are still NOT independently re-stringified — a leaf number stays a JSON number' },
  // ── Strings ────────────────────────────────────────────────────────────
  { id: 'string-newline', category: 'strings', select: "'a\\nb' AS v", chType: 'String', expected: 'a\nb', because: 'authored literal containing a real newline byte' },
  { id: 'string-nul', category: 'strings', select: "'a\\0b' AS v", chType: 'String', expected: 'a b', because: 'authored literal containing a real NUL byte — ClickHouse strings are byte strings, not C strings' },
  { id: 'string-non-bmp-unicode', category: 'strings', select: "'a\u{1F600}b' AS v", chType: 'String', expected: 'a\u{1F600}b', because: 'authored literal containing a non-BMP emoji (surrogate pair in UTF-16/JS)' },
  { id: 'string-backslash-quotes', category: 'strings', select: "'a\\\\b\"c' AS v", chType: 'String', expected: 'a\\b"c', because: 'authored literal containing a literal backslash and double quote' },
  { id: 'string-tab-cr', category: 'strings', select: "'a\\tb\\rc' AS v", chType: 'String', expected: 'a\tb\rc', because: 'authored literal containing real TAB and CR bytes' },
  { id: 'string-empty', category: 'strings', select: "'' AS v", chType: 'String', expected: '', because: 'the empty string is not the same outcome as JSON null' },
  // ── Nested structures ──────────────────────────────────────────────────
  { id: 'nested-array-of-tuples', category: 'nested', select: "[(CAST('18446744073709551615' AS UInt64), CAST('2024-06-15' AS Date))] AS v", chType: 'Array(Tuple(UInt64, Date))', expected: "[(18446744073709551615,'2024-06-15')]", because: 'CORRECTED (verified live): array-of-tuples nests the same plain-text tuple syntax (parens, unquoted UInt64, single-quoted Date) inside brackets — no JSON re-encoding at any nesting level' },
  { id: 'nested-map-of-arrays', category: 'nested', select: "map('k', [CAST('18446744073709551615' AS UInt64), CAST('0' AS UInt64)]) AS v", chType: 'Map(String, Array(UInt64))', expected: "{'k':[18446744073709551615,0]}", because: 'CORRECTED (verified live): map-of-arrays nests the same plain-text array syntax (unquoted UInt64 members) inside the single-quoted-key map syntax' },
];
