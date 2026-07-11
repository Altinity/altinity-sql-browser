// Pure typed serialization of a stored parameter value into the exact string
// sent as the `param_<name>` HTTP argument (#173).
//
// The contract, in order of precedence:
//   * A scalar **string** value passes through byte-identical — this is today's
//     behavior for every existing query, and it must not change. That includes
//     a string value against an `Array(...)` declaration (a user who typed
//     `['a','b']` by hand keeps working) and big-integer strings for
//     UInt64/128/256 / Int128/256 — they are never routed through a JS Number.
//   * An **array** value against an `Array(T)` declaration serializes to a
//     ClickHouse array literal: elements quoted-and-escaped for text-family
//     types, bare tokens for int/float, `true`/`false` for Bool; `[]` for an
//     empty array. (Verified against a live server: `['a\'b','c\\d']`-style
//     single-quote + backslash escaping, no spaces.)
//   * `null` elements are rejected in v1 (even under `Array(Nullable(T))`),
//     nested arrays (value or declaration) are rejected, and an array value
//     against a *scalar* declaration is a **structural** mismatch — the caller
//     blocks only the affected source, never silently coerces.
//
// Every result is `{ ok: true, value }` or `{ ok: false, error, structural? }`;
// this module never throws on data.

import { parseParamType, typeLexKind } from './param-type.js';
// Element-token grammars are the VALIDATOR's live-verified scalar grammars
// (review F7) — one source of truth, so the serializer can never accept a
// token (`007`, or reject `inf`) the validated scalar path decides otherwise
// on. Range stays unchecked here (the server wraps out-of-range ints; only
// the scalar validator deliberately exceeds server strictness on that).
import { INT_TOKEN, isValidFloatToken } from './param-validate.js';

const BOOL_TOKEN = /^(true|false|1|0)$/;

const quote = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// One array element → its literal token, or a thrown-free error string.
function serializeElement(el, elemType, name) {
  if (el === null || el === undefined) {
    return { error: `{${name}}: NULL array elements are not supported (Nullable element values arrive in a later phase)` };
  }
  if (Array.isArray(el)) return { error: `{${name}}: nested array values are not supported` };
  if (typeof el === 'object') return { error: `{${name}}: unsupported array element type` };
  const kind = typeLexKind(elemType);
  const token = String(el);
  if (kind === 'bool') {
    if (!BOOL_TOKEN.test(token)) return { error: `{${name}}: "${el}" is not a valid Bool element` };
    return { value: token };
  }
  if (kind === 'int') {
    // Big integers (UInt64+, Int128+) arrive as strings and are emitted
    // verbatim — validated as an integer token, never parsed into a Number.
    // The signed grammar serves UInt element types too: element tokens are a
    // lexical check only (no sign/range semantics — the server owns those).
    if (!INT_TOKEN.test(token)) return { error: `{${name}}: "${el}" is not a valid ${elemType.base} element` };
    return { value: token };
  }
  if (kind === 'float') {
    if (!isValidFloatToken(token)) return { error: `{${name}}: "${el}" is not a valid ${elemType.base} element` };
    return { value: token };
  }
  return { value: quote(token) };
}

/**
 * Serialize `value` for a parameter declared as `type` (a raw declaration
 * string or a `parseParamType` result). `name` only labels error messages.
 * Returns `{ ok: true, value }` with the exact HTTP `param_` string, or
 * `{ ok: false, error }` — with `structural: true` when the stored value's
 * *shape* is incompatible with the declaration (an array value against a
 * scalar declaration), which blocks only the affected source. Pure.
 */
export function serializeParamValue(value, type, name = 'param') {
  const t = typeof type === 'string' ? parseParamType(type) : type;
  // Legacy scalar strings flow unchanged, whatever the declaration says —
  // byte-identical with the pre-pipeline behavior.
  if (typeof value === 'string') return { ok: true, value };
  // Non-string scalars (a number/bigint/boolean a caller chose to store)
  // stringify without further interpretation.
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return { ok: true, value: String(value) };
  }
  if (Array.isArray(value)) {
    if (!t.isArray) {
      return {
        ok: false,
        structural: true,
        error: `{${name}}: an array value cannot bind a scalar ${t.raw} declaration`,
      };
    }
    if (t.elem && t.elem.isArray) {
      return { ok: false, error: `{${name}}: nested Array(...) declarations are not supported` };
    }
    const elemType = t.elem || parseParamType('String');
    const parts = [];
    for (const el of value) {
      const r = serializeElement(el, elemType, name);
      if (r.error) return { ok: false, error: r.error };
      parts.push(r.value);
    }
    return { ok: true, value: '[' + parts.join(',') + ']' };
  }
  return { ok: false, error: `{${name}}: unsupported value type` };
}
