// Compatibility projection of declared ClickHouse parameter types (`{name:Type}`
// declarations) onto the shared AST parser (#238, `clickhouse-type.js`). This
// module contains no independent parsing — every shape below is derived
// exclusively from `parseClickHouseType()` / `analyzeTypeModifiers()`.
//
// `parseParamType()` turns the raw type text of a `{name:Type}` declaration
// into the small structural shape the typed serializer (param-serialize.js)
// and the pipeline (param-pipeline.js) need: is it an array, what's the
// element type, and which lexical family does the base belong to. Its `base`/
// `inner`/`elem` describe the EFFECTIVE value type — `Nullable(...)` and
// `LowCardinality(...)` both unwrapped, recursively — so `LowCardinality(T)`
// gets exactly `T`'s validation/serialization/relative-time/Enum behavior
// without any of those consumers needing to know LowCardinality exists.
// Declaration-*identity* comparison (conflict detection) is a different
// concern — LowCardinality is transparent for VALUE handling, never for
// declaration identity — and lives in `canonicalType()`, not here.

import {
  parseClickHouseType as _parseClickHouseType,
  analyzeTypeModifiers as _analyzeTypeModifiers,
  canonicalType as _canonicalType,
  enumMembers as _astEnumMembers,
} from './clickhouse-type.js';

// The shared AST node shape `clickhouse-type.js` parses ClickHouse type
// expressions into, narrowed to exactly the fields this file reads. A
// non-type argument (Decimal's precision/scale, FixedString's length, …) is a
// `LiteralArg`, never a `TypeNode` — `parseClickHouseType`'s `validArity`
// check guarantees `Array`/`Nullable`/`LowCardinality` each carry exactly one
// `TypeNode` argument, never a literal one.
interface LiteralArg {
  kind: 'string' | 'number';
  value: string;
  raw: string;
}
type TypeArg = TypeNode | LiteralArg;
interface TypeNode {
  kind: 'type';
  name: string;
  raw: string;
  args: TypeArg[];
  members: { name: string; type: TypeNode }[] | null;
  enumMembers?: { name: string; code: number }[];
}
// `analyzeTypeModifiers` is only ever called here on a non-null `TypeNode`
// (see `fromNode`), and its unwrap loop only ever steps into another
// `TypeNode` (never a literal arg, per the same `validArity` guarantee above)
// — so, for every call site in this file, `valueType` is always a real
// `TypeNode`, never null.
interface TypeModifiers {
  valueType: TypeNode;
  nullable: boolean;
  lowCardinality: boolean;
  wrapperOrder: string[];
  lowCardinalityEnum: boolean;
  valid: boolean;
}
// `clickhouse-type.js` is unconverted (checkJs:false), so TS infers its
// exports' shapes structurally from the JS body rather than trusting these
// hand-written contracts — a plain cast pins the honest, narrower type this
// file actually relies on (verified against the wrapped function bodies).
const parseClickHouseType = _parseClickHouseType as (input: string) => TypeNode | null;
const analyzeTypeModifiers = _analyzeTypeModifiers as (node: TypeNode) => TypeModifiers;
const canonicalType = _canonicalType as (input: string) => string;
const astEnumMembers = _astEnumMembers as (node: TypeNode | null) => { name: string; code: number }[] | null;

// An Array's single argument is always a type node, never a literal one (see
// the `TypeArg` comment above) — this narrows that invariant for the
// recursive `elem` projection below without inventing a new runtime state
// (the check is always true for real data; it never changes behavior).
function isTypeNode(arg: TypeArg): arg is TypeNode {
  return arg.kind === 'type';
}

/**
 * The compatibility shape `parseParamType` and its siblings project a
 * declared parameter type into — see `parseParamType`'s own doc comment for
 * what each field means.
 */
export interface ParsedParamType {
  raw: string;
  base: string;
  inner: string | null;
  nullable: boolean;
  isArray: boolean;
  elem: ParsedParamType | null;
  node: TypeNode | null;
}

// Integer bases. UInt64 and up (and Int64 and up) exceed Number.MAX_SAFE_INTEGER,
// which is why the serializer never routes numeric tokens through a JS Number —
// classification here is purely about literal quoting, not about range.
const INT_BASE = /^U?Int(8|16|32|64|128|256)$/;
// Float-family bases: emitted unquoted, decimal point / exponent allowed.
const FLOAT_BASE = /^(Float32|Float64|BFloat16|Decimal(32|64|128|256)?)$/;
const ENUM_BASE = /^Enum(8|16)$/;

// The raw text between a type's own outer parens (`'10, 2'` for
// `Decimal(10, 2)`), or null for a bare scalar — same contract the old
// regex-based parser exposed as `inner` (including its `.trim()`: the old
// parser's capture group was matched loosely and always trimmed).
function innerOf(raw: string): string | null {
  const i = raw.indexOf('(');
  return i < 0 ? null : raw.slice(i + 1, raw.length - 1).trim();
}

// Project one AST node (already resolved to whatever nesting level a caller
// cares about) into the compatibility shape, unwrapping Nullable/
// LowCardinality down to the effective value type at every level — including
// recursively into an Array's element, so `Array(LowCardinality(UInt64))`'s
// `elem.base` is `'UInt64'`, not `'LowCardinality'`. `node` always comes from
// a tree `parseClickHouseType` already validated in full (recursively), so an
// `Array`-named `value` is guaranteed exactly one arg — no separate check needed.
// Deliberately ignores `mods.valid`'s wrapper-ORDER component: parameter
// validation/serialization only ever needs the effective value type, whatever
// order produced it — unlike `isSupportedOptionScalar` (clickhouse-type.js),
// which IS the authoritative "is this a supported scalar" check and does
// reject `Nullable(LowCardinality(T))`, param declarations stay permissive
// about ordering by design. `mods.lowCardinalityEnum` is different: no
// ClickHouse version accepts `LowCardinality` wrapping an `Enum8`/`Enum16` at
// all (regardless of order), so that degrades exactly like an unparseable
// declaration — opaque passthrough, no Enum-specific behavior anywhere.
function fromNode(node: TypeNode): ParsedParamType {
  const mods = analyzeTypeModifiers(node);
  if (mods.lowCardinalityEnum) {
    return { raw: node.raw, base: node.raw, inner: null, nullable: false, isArray: false, elem: null, node: null };
  }
  const value = mods.valueType;
  const isArray = value.name === 'Array';
  const firstArg = isArray ? value.args[0] : null;
  return {
    raw: node.raw,
    base: value.name,
    inner: innerOf(value.raw),
    nullable: mods.nullable,
    isArray,
    elem: firstArg && isTypeNode(firstArg) ? fromNode(firstArg) : null,
    node: value,
  };
}

/**
 * Parse a declared parameter type into `{ raw, base, inner, nullable, isArray,
 * elem, node }`:
 *   - `raw`      — the trimmed declaration text, verbatim;
 *   - `base`     — the EFFECTIVE type name, after unwrapping any
 *                  `Nullable(...)` / `LowCardinality(...)` wrappers, in
 *                  whatever order they appear (`'String'`, `'UInt64'`,
 *                  `'Array'`, `'Enum8'`, …);
 *   - `inner`    — the raw text between the effective type's own parentheses
 *                  (`'String'` for `Array(String)`, `'10, 2'` for
 *                  `Decimal(10, 2)`), or null;
 *   - `nullable` — true when `Nullable(...)` appears anywhere in the wrapper
 *                  chain;
 *   - `isArray`  — true when the effective base is `Array`;
 *   - `elem`     — the recursively projected element type for arrays, else
 *                  null;
 *   - `node`     — the resolved (wrapper-stripped) AST node, for helpers that
 *                  want it directly (`enumMembers` below) without reparsing.
 * A shape this module can't parse (unbalanced parens, exotic text) degrades to
 * an opaque scalar (`base` = the whole text) — the serializer treats opaque
 * scalars as passthrough, so an unrecognized type never blocks anything the
 * server itself might accept. Pure.
 */
export function parseParamType(raw?: string | null): ParsedParamType {
  const text = String(raw || '').trim();
  const node = parseClickHouseType(text);
  if (!node) return { raw: text, base: text, inner: null, nullable: false, isArray: false, elem: null, node: null };
  return { ...fromNode(node), raw: text };
}

/** Strict declaration predicate for saved-query time-range metadata. Unlike
 * the permissive value pipeline, this accepts only syntactically valid scalar
 * ClickHouse date/time declarations, valid wrapper ordering, DateTime's
 * optional timezone, and DateTime64 precision 0..9 plus optional timezone. */
export function isSupportedTimeRangeParamType(raw?: string | null): boolean {
  const node = parseClickHouseType(String(raw || '').trim());
  if (!node) return false;
  const mods = analyzeTypeModifiers(node);
  if (!mods.valid) return false;
  const value = mods.valueType;
  if (value.name === 'Date' || value.name === 'Date32') return value.args.length === 0;
  if (value.name === 'DateTime') {
    return value.args.length === 0
      || (value.args.length === 1 && value.args[0].kind === 'string' && value.args[0].value.trim().length > 0);
  }
  if (value.name !== 'DateTime64' || value.args.length < 1 || value.args.length > 2) return false;
  const precision = value.args[0];
  if (precision.kind !== 'number' || !/^\d+$/.test(precision.value)) return false;
  const n = Number(precision.value);
  if (!Number.isInteger(n) || n < 0 || n > 9) return false;
  return value.args.length === 1
    || (value.args[1].kind === 'string' && value.args[1].value.trim().length > 0);
}

/** Explicit IANA timezone carried by a valid DateTime/DateTime64 declaration,
 * or null when the type uses the existing server-timezone default. */
export function dateTimeTimeZone(type: string | ParsedParamType): string | null {
  const parsed = typeof type === 'string' ? parseParamType(type) : type;
  if (!parsed.node) return null;
  const value = analyzeTypeModifiers(parsed.node).valueType;
  if (value.name === 'DateTime' && value.args.length === 1 && value.args[0].kind === 'string') return value.args[0].value;
  if (value.name === 'DateTime64' && value.args.length === 2 && value.args[1].kind === 'string') return value.args[1].value;
  return null;
}

/**
 * The lexical family of a parsed (or raw) type, deciding how the typed
 * serializer emits an array *element* of that type:
 *   - `'int'`   — unquoted integer token (Int8…Int256, UInt8…UInt256);
 *   - `'float'` — unquoted numeric token, decimal point/exponent allowed
 *                 (Float32/64, BFloat16, Decimal…);
 *   - `'bool'`  — `true`/`false`;
 *   - `'text'`  — single-quoted with backslash escaping (String, UUID, Date,
 *                 DateTime, Enum, IPv4/6, and anything unrecognized).
 * Pure.
 * @param type parsed type or raw declaration text
 */
export function typeLexKind(type: string | ParsedParamType): 'int' | 'float' | 'bool' | 'text' {
  const base = typeof type === 'string' ? parseParamType(type).base : type.base;
  if (INT_BASE.test(base)) return 'int';
  if (FLOAT_BASE.test(base)) return 'float';
  if (base === 'Bool' || base === 'Boolean') return 'bool';
  return 'text';
}

/**
 * The distinct canonical types among a field's declarations — `null` when
 * they all agree (no conflict), otherwise the conflicting set in first-seen
 * order. Comparison is by `canonicalType()` (#238): whitespace-insensitive
 * outside quoted content, but wrapper-sensitive — `LowCardinality(String)`
 * is a DIFFERENT declaration from `String`, never the same conflict-free
 * type, even though the two are interchangeable for value handling. Built on
 * the all-occurrences scan (every declaration participates, including ones
 * in non-bound statements: they are still declarations of the same name, and
 * a disagreement should surface as a diagnostic). Pure.
 */
export function conflictingTypes(declarations?: { type: string }[] | null): string[] | null {
  const seen: string[] = [];
  for (const d of declarations || []) {
    const t = canonicalType(d.type);
    if (!seen.includes(t)) seen.push(t);
  }
  return seen.length > 1 ? seen : null;
}

/**
 * Parse an `Enum8`/`Enum16` declared type's members into `{name, code}`
 * pairs (in declaration order), unwrapping `Nullable(...)` first, or `null`
 * when the effective type isn't `Enum8`/`Enum16` — including a
 * `LowCardinality`-wrapped Enum in any nesting order, which `fromNode`
 * already degrades to an opaque shape (`base` is the raw declaration text,
 * `node: null`) because no ClickHouse version accepts that combination.
 * Delegates to the shared AST's `enumMembers()` — see `clickhouse-type.js`
 * for the escaping/heredoc/explicit-code/implicit-code grammar and the
 * `LowCardinality`-Enum invalidity rule. `t.base` can only equal
 * `'Enum8'`/`'Enum16'` when `t.node` resolved to a real, already
 * value-transparent-unwrapped Enum node, so once the base check passes this
 * always gets a real member array (possibly empty) back, never `null`. Pure.
 */
export function enumMembers(type: string | ParsedParamType): { name: string; code: number }[] | null {
  const t = typeof type === 'string' ? parseParamType(type) : type;
  if (!ENUM_BASE.test(t.base)) return null;
  return astEnumMembers(t.node);
}

/**
 * The member NAMES of an `Enum8`/`Enum16` declared type, in declaration
 * order — the dropdown-option list #172 v1 (declared type) and v2
 * (schema-cache inference) both render — or `null` for any other type AND
 * for an enum whose member list yields nothing (a bare `Enum8`, an
 * empty/unparseable list): null, never `[]`, so every truthiness-checking
 * consumer (the field builders in app.js / dashboard.js) falls back to the
 * plain input instead of rendering an empty dropdown. Pure.
 */
export function enumValues(type: string | ParsedParamType): string[] | null {
  const members = enumMembers(type);
  return members && members.length ? members.map((m) => m.name) : null;
}
