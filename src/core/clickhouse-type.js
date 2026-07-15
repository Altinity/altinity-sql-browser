// Pure parser and queries for ClickHouse type expressions (#238) — the single
// recursive AST shared by declared `{name:Type}` parameters (param-type.js and
// its consumers) and result-column types (KPI, Dashboard Filter helpers).
//
// Every parsed node is `{kind:'type', name, raw, args, members, enumMembers}`:
//   - `args`    — nested type nodes and/or literal argument nodes, positional;
//   - `members` — named Tuple members (`{name, type}`), or null for a
//                 positional/argument-free Tuple or any other type;
//   - `enumMembers` — `Enum8`/`Enum16` members (`{name, code}`), or undefined
//                 for every other type.
// A literal argument (`Decimal`'s precision/scale, `FixedString`'s length,
// `DateTime`'s timezone) is `{kind:'number'|'string', value, raw}` — never a
// fake type node. Malformed syntax returns `null`.
//
// LowCardinality and Nullable are *wrappers*, not scalars: `unwrapNullable`
// only strips `Nullable(...)`, `unwrapLowCardinality` only strips
// `LowCardinality(...)`, and `unwrapValueTransparentWrappers` strips both
// (in any order) for consumers that want the effective *value* type. Wrapper
// *order* is semantically significant — `LowCardinality(Nullable(T))` is the
// only valid combined form; `Nullable(LowCardinality(T))` parses (syntax is
// permissive) but `analyzeTypeModifiers` marks it invalid — see there.
// `LowCardinality` wrapping an `Enum8`/`Enum16` is invalid regardless of
// nesting order (no ClickHouse version accepts it at all) — also flagged by
// `analyzeTypeModifiers`, not a separate special case in each consumer.
//
// Enum member parsing (escaped/heredoc names, explicit/implicit codes) is
// ported from the pre-#238 `param-type.js` implementation, itself built on
// `sql-spans.js`'s `scanSpans` — the same lexical scanner used for canonical
// formatting below. Quoted-token boundary scanning (single quotes, backticks,
// double quotes, in the tokenizer below) shares `quoted-span.js`'s
// `scanDelimited` with `sql-spans.js` (#241) — one authoritative backslash
// and doubled-delimiter rule, never two independent implementations.

import { scanSpans } from './sql-spans.js';
import { scanDelimited } from './quoted-span.js';

// Undo one quoted token's escaping (#241): `\` consumes the next character
// verbatim (whatever it is, not just the delimiter or another backslash —
// same "escapes the following character verbatim" rule #182 already
// established for Enum member names, now shared instead of Tuple/quoted-
// identifier names using a narrower backslash-only-before-a-delimiter rule),
// and a DOUBLED delimiter (`''`, `` `` ``, `""`) is a literal delimiter
// character, not a terminator — the same two rules `scanDelimited` used to
// find the token's boundary in the first place, so a name round-trips
// exactly regardless of which of the three delimiters it used
// (`` `a``b` `` / `"a""b"` / `'a''b'` → `` a`b ``/`a"b`/`a'b`).
function decodeQuoted(raw, quote) {
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) { out += body[i + 1]; i += 1; continue; }
    if (c === quote && body[i + 1] === quote) { out += quote; i += 1; continue; }
    out += c;
  }
  return out;
}

const unquote = (token) => token.quoted ? decodeQuoted(token.value, token.value[0]) : token.value;

const isWordChar = (c) => /[A-Za-z0-9_]/.test(c);

// From a `$` at `i`, the end offset (exclusive) of a valid `$[A-Za-z0-9_]*$`
// heredoc opener, or -1 when the tag is non-word / there is no second `$` —
// the same grammar `sql-spans.js` uses. A non-word tag falls through to an
// ordinary bare-word token.
function heredocOpenerEnd(text, i) {
  let j = i + 1;
  while (j < text.length && isWordChar(text[j])) j += 1;
  return text[j] === '$' ? j + 1 : -1;
}

function tokenize(text) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) { i++; continue; }
    if ('(),'.includes(text[i])) { tokens.push({ value: text[i], start: i, end: ++i }); continue; }
    if ('`"\''.includes(text[i])) {
      const quote = text[i];
      const start = i;
      const { end, closed } = scanDelimited(text, start, quote);
      if (!closed) return null;
      i = end;
      tokens.push({ value: text.slice(start, i), start, end: i, quoted: true });
      continue;
    }
    // A `$tag$…$tag$` heredoc (Enum member names, #182) — checked at every
    // fresh token position, same as the other quote forms above, so its body
    // (which may legally contain `(`, `)`, `,`, and stray `'`/`"`/`` ` ``
    // characters) is consumed as ONE atomic token rather than corrupting the
    // surrounding scan the way those characters would if left to the bare-
    // word/quote branches. An unrecognized `$` (no valid tag) falls through
    // to the ordinary bare-word run below, unchanged.
    if (text[i] === '$') {
      const openEnd = heredocOpenerEnd(text, i);
      if (openEnd >= 0) {
        const opener = text.slice(i, openEnd);
        const close = text.indexOf(opener, openEnd);
        if (close < 0) return null;
        const start = i;
        i = close + opener.length;
        tokens.push({ value: text.slice(start, i), start, end: i, quoted: true });
        continue;
      }
    }
    const start = i;
    while (i < text.length && !/[\s(),]/.test(text[i])) i++;
    tokens.push({ value: text.slice(start, i), start, end: i, quoted: false });
  }
  return tokens;
}

// ── Enum member parsing (ported from the pre-#238 param-type.js) ──────────

const ENUM_NAME_RE = /^Enum(?:8|16)$/;

// A single member's `= <code>` assignment, found in the *code* span that
// immediately follows its quoted name (`'active' = 1` → the code span is
// " = 1, " or " = 1" up to the closing paren). Leading/trailing text besides
// the assignment (separators, the next member's opening quote) is ignored —
// only the leading `= <int>` is meaningful here.
const ENUM_CODE_RE = /^\s*=\s*(-?\d+)/;

// Decode one Enum member NAME from a `string`-kind span (#182): a
// single-quoted literal uses ClickHouse's backslash/doubled-quote rules
// (the shared `decodeQuoted`); a `$tag$…$tag$` heredoc is opaque — strip the
// exact opener and (equal-length) closer and return the body verbatim, with
// no unescaping. An unterminated span (`closed: false`) is not a member →
// null — defensive: the tokenizer (#241) and this module's own `scanSpans`
// re-scan now share one escaping rule via `scanDelimited`, so in practice
// every span reaching here is already closed, but never assume it without
// checking. `quoted-ident` spans never reach here, so `Enum8("x" = 1)`
// yields no member.
function decodeEnumMemberSpan(raw, closed) {
  if (!closed) return null;
  if (raw[0] === "'") return decodeQuoted(raw, "'");
  const openLen = raw.indexOf('$', 1) + 1; // past the opener's closing `$`
  return raw.slice(openLen, raw.length - openLen);
}

// Parse an Enum8/Enum16's member-list TEXT (between its outer parens) into
// `{name, code}` pairs, in declaration order. ClickHouse allows OMITTING the
// `= <code>` assignment — implicit members auto-number from 1, continuing
// from the previous member's code + 1 (an explicit code resets the counter,
// including negative ones). Pure.
function parseEnumMembers(text) {
  const spans = [...scanSpans(text)];
  const members = [];
  let nextCode = 1;
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (sp.kind !== 'string') continue; // quoted-ident / comment / code aren't members
    const name = decodeEnumMemberSpan(text.slice(sp.start, sp.end), sp.closed);
    if (name == null) continue; // an unterminated literal is not a member
    const next = spans[i + 1];
    const m = next && next.kind === 'code' ? ENUM_CODE_RE.exec(text.slice(next.start, next.end)) : null;
    const code = m ? Number(m[1]) : nextCode;
    members.push({ name, code });
    nextCode = code + 1;
  }
  return members;
}

// ── Parser ───────────────────────────────────────────────────────────────

export function parseClickHouseType(input) {
  const text = String(input || '').trim();
  const tokens = tokenize(text);
  if (!text || !tokens) return null;
  let pos = 0;

  // One argument position: a quoted literal, a bare integer literal, or a
  // nested type. Used for every type's argument list except Tuple (its
  // members need 2-token lookahead for the named/positional decision) and
  // Enum8/Enum16 (a `'name' = code` list, not type arguments at all). Only
  // ever called from inside the `pos < tokens.length` loop below, so a token
  // is always present.
  const parseArg = () => {
    const token = tokens[pos];
    if (token.quoted) {
      pos++;
      return { kind: 'string', value: unquote(token), raw: token.value };
    }
    if (/^-?\d+$/.test(token.value)) {
      pos++;
      return { kind: 'number', value: token.value, raw: token.value };
    }
    return parseType();
  };

  const parseType = () => {
    const token = tokens[pos];
    if (!token || token.quoted || '(),'.includes(token.value)) return null;
    const start = token.start;
    const name = token.value;
    pos++;
    const node = { kind: 'type', name, raw: '', args: [], members: null };
    if (tokens[pos]?.value !== '(') {
      node.raw = text.slice(start, token.end);
      return node;
    }
    const openParen = tokens[pos];
    pos++;
    // Enum8/Enum16 argument lists are `'name' = number, ...` pairs, not
    // nested types — parsing them as types would reject the leading quoted
    // member name. Skip to the matching close paren by plain token depth
    // counting (heredocs already tokenize atomically above, so their
    // internal `(`/`)`/`,` characters never appear as separate tokens here),
    // then parse the member list from that exact text span.
    if (ENUM_NAME_RE.test(name)) {
      let depth = 1;
      while (pos < tokens.length && depth > 0) {
        if (tokens[pos].value === '(') depth++;
        else if (tokens[pos].value === ')') depth--;
        pos++;
      }
      if (depth !== 0) return null;
      const close = tokens[pos - 1];
      node.raw = text.slice(start, close.end);
      node.enumMembers = parseEnumMembers(text.slice(openParen.end, close.start));
      return node;
    }
    if (tokens[pos]?.value === ')') {
      node.raw = text.slice(start, tokens[pos++].end);
      return node;
    }
    const tupleMembers = [];
    while (pos < tokens.length) {
      if (name === 'Tuple') {
        const first = tokens[pos];
        const second = tokens[pos + 1];
        const named = first && (first.quoted
          || (second && !second.quoted && !'(),'.includes(second.value)));
        if (named) {
          pos++;
          const type = parseType();
          if (!type) return null;
          tupleMembers.push({ name: unquote(first), type });
        } else {
          const type = parseType();
          if (!type) return null;
          node.args.push(type);
        }
      } else {
        const arg = parseArg();
        if (!arg) return null;
        node.args.push(arg);
      }
      if (tokens[pos]?.value === ',') { pos++; continue; }
      if (tokens[pos]?.value !== ')') return null;
      const close = tokens[pos++];
      // A Tuple mixing named and positional members at the top level is
      // rejected outright — there's no single authoritative member order to
      // report both ways.
      if (tupleMembers.length && node.args.length) return null;
      if (tupleMembers.length) node.members = tupleMembers;
      node.raw = text.slice(start, close.end);
      return node;
    }
    return null;
  };

  const node = parseType();
  // Every arg of these wrapper names must itself be a nested TYPE, never a
  // literal number/string node (`Array(123)` is not a type expression) —
  // `parseArg` doesn't know which type names it's parsing an argument for,
  // so this is the one place that enforces it.
  const onlyTypeArgs = (value) => value.args.every((a) => a.kind === 'type');
  const validArity = (value) => {
    if (!value) return false;
    if (value.kind !== 'type') return true; // a literal arg has no sub-structure to check
    if ((value.name === 'Array' || value.name === 'Nullable' || value.name === 'LowCardinality')
      && (value.args.length !== 1 || !onlyTypeArgs(value))) return false;
    if (value.name === 'Map' && (value.args.length !== 2 || !onlyTypeArgs(value))) return false;
    return value.args.every(validArity) && (!value.members || value.members.every((member) => validArity(member.type)));
  };
  return pos === tokens.length && validArity(node) ? node : null;
}

// ── Wrapper helpers ──────────────────────────────────────────────────────

/** Strip `Nullable(...)` only — never `LowCardinality(...)`. Pure. */
export function unwrapNullable(node) {
  let current = node;
  while (current && current.kind === 'type' && current.name === 'Nullable' && current.args.length === 1) {
    current = current.args[0];
  }
  return current || null;
}

/** Strip `LowCardinality(...)` only — never `Nullable(...)`. Pure. */
export function unwrapLowCardinality(node) {
  let current = node;
  while (current && current.kind === 'type' && current.name === 'LowCardinality' && current.args.length === 1) {
    current = current.args[0];
  }
  return current || null;
}

/**
 * Strip BOTH `Nullable(...)` and `LowCardinality(...)`, in whatever order
 * they were nested, down to the effective *value* type — for consumers that
 * only care what kind of value flows through (KPI numeric detection, Filter
 * helper scalar/array/map element types, parameter validation/serialization).
 * Not for declaration-identity comparison — see `canonicalType`. Pure.
 */
export function unwrapValueTransparentWrappers(node) {
  let current = node;
  while (current && current.kind === 'type' && (current.name === 'Nullable' || current.name === 'LowCardinality') && current.args.length === 1) {
    current = current.args[0];
  }
  return current || null;
}

/**
 * The full wrapper analysis: the effective value type, which wrappers were
 * present, their nesting order (outermost first), and whether that order is
 * one ClickHouse actually supports. The only valid combined form is
 * `LowCardinality(Nullable(T))` (LowCardinality outermost); a bare `Nullable`
 * or bare `LowCardinality` alone is also valid; `Nullable(LowCardinality(T))`
 * parses (the parser stays permissive about syntax) but is flagged invalid
 * here — callers that need to tell "an ordinary supported scalar" apart from
 * this malformed order (`isSupportedOptionScalar` below) must check `valid`,
 * not just the unwrapped type's name.
 *
 * `LowCardinality` wrapping an `Enum8`/`Enum16` is ALSO always invalid,
 * regardless of nesting order — live-verified against ClickHouse 26.3.13:
 * `DataTypeLowCardinality is supported only for numbers, strings, Date or
 * DateTime, but got Enum8(...)`. This is not an ordering mistake like
 * `Nullable(LowCardinality(T))`; no ClickHouse version accepts
 * `LowCardinality` around an Enum at all, so it folds into the same `valid`
 * flag rather than a separate one. Pure.
 */
export function analyzeTypeModifiers(node) {
  let current = node;
  const wrapperOrder = [];
  while (current && current.kind === 'type' && (current.name === 'Nullable' || current.name === 'LowCardinality') && current.args.length === 1) {
    wrapperOrder.push(current.name);
    current = current.args[0];
  }
  const lowCardinality = wrapperOrder.includes('LowCardinality');
  const orderValid = wrapperOrder.length <= 1
    || (wrapperOrder.length === 2 && wrapperOrder[0] === 'LowCardinality' && wrapperOrder[1] === 'Nullable');
  // Exposed separately from `valid` (rather than folded in silently) because
  // callers that stay deliberately permissive about wrapper ORDER (param-type.js)
  // must NOT stay permissive about this — no ClickHouse version accepts it,
  // so it isn't an ordering nuance to shrug off, it's an unsupported type.
  const lowCardinalityEnum = lowCardinality && current?.kind === 'type' && ENUM_NAME_RE.test(current.name);
  return {
    valueType: current || null,
    nullable: wrapperOrder.includes('Nullable'),
    lowCardinality,
    wrapperOrder,
    lowCardinalityEnum,
    valid: orderValid && !lowCardinalityEnum,
  };
}

// ── Structural queries ───────────────────────────────────────────────────

/** The node's type name (`'String'`, `'Array'`, …), or `null` for a literal
 *  argument node or a missing node. Pure. */
export function typeBaseName(node) {
  return node && node.kind === 'type' ? node.name : null;
}

export function arrayElement(node) {
  const value = unwrapNullable(node);
  return value?.name === 'Array' && value.args.length === 1 ? value.args[0] : null;
}

export function mapTypes(node) {
  const value = unwrapNullable(node);
  return value?.name === 'Map' && value.args.length === 2 ? value.args : null;
}

export function namedTupleMembers(node) {
  const value = unwrapNullable(node);
  return value?.name === 'Tuple' && value.members?.length ? value.members : null;
}

/**
 * An Enum8/Enum16 declaration's members, unwrapping `Nullable(...)` first —
 * `{name, code}` pairs in declaration order, or `null` for any non-Enum type
 * AND for a semantically invalid wrapper combination (`analyzeTypeModifiers`
 * — most notably `LowCardinality` wrapping the Enum, which no ClickHouse
 * version supports: no Enum dropdown/membership behavior for a declaration
 * that can never bind on a real server). Pure.
 */
export function enumMembers(node) {
  const mods = analyzeTypeModifiers(node);
  if (!mods.valid) return null;
  const value = mods.valueType;
  return value && ENUM_NAME_RE.test(value.name) ? (value.enumMembers ?? []) : null;
}

/**
 * The member NAMES of an Enum8/Enum16 declaration, in declaration order, or
 * `null` for a non-Enum type AND for an Enum whose member list yields nothing
 * (never `[]`, so a truthiness check never renders an empty dropdown). Pure.
 */
export function enumValues(node) {
  const members = enumMembers(node);
  return members && members.length ? members.map((m) => m.name) : null;
}

const SCALAR_NAME_RE = /^(?:String|FixedString|UUID|U?Int(?:8|16|32|64|128|256)|Decimal(?:32|64|128|256)?|Float(?:32|64)|Bool|Date|Date32|DateTime|DateTime64|Enum(?:8|16))$/;

/**
 * Is `node` an ordinary supported scalar, seen through a *valid* wrapper
 * order? A semantically invalid order (`Nullable(LowCardinality(T))`) is
 * never classified as a supported scalar, even though its inner type would
 * otherwise qualify — see `analyzeTypeModifiers`. Pure.
 */
export function isSupportedOptionScalar(node) {
  const mods = analyzeTypeModifiers(node);
  if (!mods.valid) return false;
  return !!mods.valueType && SCALAR_NAME_RE.test(mods.valueType.name);
}

// ── Canonical formatting (for declaration-identity comparison) ───────────

/**
 * A canonical form of a type declaration for conflict comparison:
 * whitespace-insensitive OUTSIDE quoted/heredoc content, byte-identical
 * INSIDE it — so `Array( String )` normalizes the same as `Array(String)`,
 * but `Enum8('a b' = 1)`'s quoted member name is never mangled the way a
 * blanket whitespace-strip would. Operates directly on the raw text (via the
 * same lexical scanner the parser and Enum-member parsing use) rather than
 * walking the AST, so it never restructures anything — wrapper order and
 * Enum member names/codes are preserved for free, and a malformed/unparsable
 * declaration still compares sensibly against another textually-similar one.
 * `input` may be a raw string or a parsed node (its `.raw` is used). Pure.
 */
export function canonicalType(input) {
  const text = typeof input === 'string' ? input : (input && input.raw) || '';
  let out = '';
  for (const span of scanSpans(text)) {
    const piece = text.slice(span.start, span.end);
    out += span.kind === 'code' ? piece.replace(/\s+/g, '') : piece;
  }
  return out;
}
