// Pure parsing + comparison of declared ClickHouse parameter types (#173).
// `parseParamType` turns the raw type text of a `{name:Type}` declaration into
// the small structural shape the typed serializer (param-serialize.js) and the
// pipeline (param-pipeline.js) need: is it an array, what's the element type,
// is it Nullable-wrapped, and which lexical family does the base belong to.
// #170's validator and #172's enum parsing build on this module.

import { scanSpans } from './sql-spans.js';

// Integer bases. UInt64 and up (and Int64 and up) exceed Number.MAX_SAFE_INTEGER,
// which is why the serializer never routes numeric tokens through a JS Number —
// classification here is purely about literal quoting, not about range.
const INT_BASE = /^U?Int(8|16|32|64|128|256)$/;
// Float-family bases: emitted unquoted, decimal point / exponent allowed.
const FLOAT_BASE = /^(Float32|Float64|BFloat16|Decimal(32|64|128|256)?)$/;
const ENUM_BASE = /^Enum(8|16)$/;

/**
 * Parse a declared parameter type into `{ raw, base, inner, nullable, isArray,
 * elem }`:
 *   - `raw`      — the trimmed declaration text, verbatim;
 *   - `base`     — the outer type name after unwrapping `Nullable(...)`
 *                  (`'String'`, `'UInt64'`, `'Array'`, `'Enum8'`, …);
 *   - `inner`    — the raw text between the base's parentheses (`'String'` for
 *                  `Array(String)`, `'10, 2'` for `Decimal(10, 2)`), or null;
 *   - `nullable` — true when wrapped in `Nullable(...)`;
 *   - `isArray`  — true when the base is `Array`;
 *   - `elem`     — the recursively parsed element type for arrays, else null.
 * A shape this module can't parse (unbalanced parens, exotic text) degrades to
 * an opaque scalar (`base` = the whole text) — the serializer treats opaque
 * scalars as passthrough, so an unrecognized type never blocks anything the
 * server itself might accept. Pure.
 * @param {string} raw
 */
export function parseParamType(raw) {
  const text = String(raw || '').trim();
  const m = /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/.exec(text);
  const base = m ? m[1] : text;
  const inner = m ? m[2].trim() : null;
  if (base === 'Nullable' && inner != null) {
    return { ...parseParamType(inner), raw: text, nullable: true };
  }
  const isArray = base === 'Array';
  return {
    raw: text,
    base,
    inner,
    nullable: false,
    isArray,
    elem: isArray && inner != null ? parseParamType(inner) : null,
  };
}

/**
 * A whitespace-insensitive canonical form of a declared type, for conflict
 * comparison: `Array( String )` and `Array(String)` are the same declaration.
 * (A type whose quoted portion contains whitespace — `Enum8('a b' = 1)` —
 * compares loosely; the worst case is a missed conflict diagnostic, never a
 * wrong serialization, since serialization is per-statement by the local
 * declaration.) Pure.
 */
export function normalizeParamType(raw) {
  return String(raw || '').replace(/\s+/g, '');
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
 * @param {{base: string}|string} type parsed type or raw declaration text
 */
export function typeLexKind(type) {
  const base = typeof type === 'string' ? parseParamType(type).base : type.base;
  if (INT_BASE.test(base)) return 'int';
  if (FLOAT_BASE.test(base)) return 'float';
  if (base === 'Bool' || base === 'Boolean') return 'bool';
  return 'text';
}

/**
 * The distinct normalized types among a field's declarations — `null` when
 * they all agree (no conflict), otherwise the conflicting set in first-seen
 * order. Built on the all-occurrences scan (every declaration participates,
 * including ones in non-bound statements: they are still declarations of the
 * same name, and a disagreement should surface as a diagnostic). Pure.
 * @param {{type: string}[]} declarations
 * @returns {string[]|null}
 */
export function conflictingTypes(declarations) {
  const seen = [];
  for (const d of declarations || []) {
    const t = normalizeParamType(d.type);
    if (!seen.includes(t)) seen.push(t);
  }
  return seen.length > 1 ? seen : null;
}

// A single member's `= <code>` assignment, found in the *code* span that
// immediately follows its quoted name (`'active' = 1` → the code span is
// " = 1, " or " = 1" up to the closing paren). Leading/trailing text besides
// the assignment (separators, the next member's opening quote) is ignored —
// only the leading `= <int>` is meaningful here.
const ENUM_CODE_RE = /^\s*=\s*(-?\d+)/;

// Undo ClickHouse's single-quoted string escaping for one member name:
// `\` escapes the following character verbatim, and a doubled quote (`''`) is
// an escaped literal quote, not a terminator — the same two rules
// `sql-spans.js` used to find the span's end in the first place, so a name
// round-trips exactly (`'a''b'` → `a'b`, `'}'` → `}`).
function unescapeEnumMember(quoted) {
  const body = quoted.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) { out += body[i + 1]; i += 1; continue; }
    if (c === "'" && body[i + 1] === "'") { out += "'"; i += 1; continue; }
    out += c;
  }
  return out;
}

/**
 * Parse an `Enum8`/`Enum16` declared type's members into `{name, code}`
 * pairs (in declaration order), or `null` when `type`'s base isn't
 * `Enum8`/`Enum16` (`Nullable(...)` already unwrapped by `parseParamType`).
 * Reuses the shared string-span scanner (`sql-spans.js`, also behind
 * `param-scan.js`'s brace matching) to find each quoted member name, so
 * escaped quotes (`'a''b'`), braces (`'}'`), backslash escapes, spacing
 * variants, and unicode member names all parse exactly like ClickHouse's own
 * string literal grammar. A member with no explicit `= <code>` is dropped —
 * ClickHouse's Enum syntax always assigns one explicitly, so anything else is
 * unparsed rather than guessed at. Pure.
 * @param {string|ReturnType<typeof parseParamType>} type
 * @returns {{name: string, code: number}[]|null}
 */
export function enumMembers(type) {
  const t = typeof type === 'string' ? parseParamType(type) : type;
  if (!ENUM_BASE.test(t.base)) return null;
  const text = t.inner || '';
  const spans = [...scanSpans(text)];
  const members = [];
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (sp.kind !== 'string') continue;
    const name = unescapeEnumMember(text.slice(sp.start, sp.end));
    const next = spans[i + 1];
    const m = next && next.kind === 'code' ? ENUM_CODE_RE.exec(text.slice(next.start, next.end)) : null;
    if (m) members.push({ name, code: Number(m[1]) });
  }
  return members;
}

/**
 * The member NAMES of an `Enum8`/`Enum16` declared type, in declaration
 * order, or `null` for any other type (`Nullable(...)` unwrapped) — the
 * dropdown-option list #172 v1 (declared type) and v2 (schema-cache
 * inference) both render. Pure.
 * @param {string|ReturnType<typeof parseParamType>} type
 * @returns {string[]|null}
 */
export function enumValues(type) {
  const members = enumMembers(type);
  return members ? members.map((m) => m.name) : null;
}
