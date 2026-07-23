// Pure saved-query Spec draft parsing, validation, normalization, and
// serialization. The workbench/editor layers own presentation and source
// markers; this module owns the deterministic data contract.

import { cloneJson } from './saved-query.js';
import {
  createQuerySpecValidationService as _createQuerySpecValidationService,
  // Kept for parity with the pre-conversion module — unused here, same as
  // before (spec-schema.js's own export, consumed directly by other modules).
  querySpecSchemaService,
} from './spec-schema.js';
import { filterSqlDiagnostics } from './filter-execution.js';
import type { QuerySpecV1 } from '../generated/json-schema.types.js';
import { hasSameTimeRangeParameter } from './query-time-range.js';

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isHex = (ch: string): boolean => /[0-9a-f]/i.test(ch);
const isWs = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

class JsonSyntaxError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

function scanJson(text: string): void {
  let pos = 0;
  const fail = (message: string, at: number = pos): never => { throw new JsonSyntaxError(message, at); };
  const ws = (): void => { while (pos < text.length && isWs(text[pos])) pos++; };

  const string = (): void => {
    // Callers enter only after checking the opening quote.
    pos++;
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === '"') return;
      if (ch.charCodeAt(0) < 0x20) fail('Control character in string', pos - 1);
      if (ch !== '\\') continue;
      if (pos >= text.length) fail('Unterminated escape sequence', pos - 1);
      const esc = text[pos++];
      if ('"\\/bfnrt'.includes(esc)) continue;
      if (esc !== 'u') fail('Invalid escape sequence', pos - 2);
      if (pos + 4 > text.length || ![...text.slice(pos, pos + 4)].every(isHex)) {
        fail('Invalid Unicode escape', pos);
      }
      pos += 4;
    }
    fail('Unterminated string', Math.max(0, pos - 1));
  };

  const number = (): void => {
    const start = pos;
    if (text[pos] === '-') pos++;
    if (text[pos] === '0') pos++;
    else {
      if (!isDigit(text[pos]) || text[pos] === '0') fail('Invalid number', start);
      while (isDigit(text[pos])) pos++;
    }
    if (text[pos] === '.') {
      pos++;
      if (!isDigit(text[pos])) fail('Expected digits after decimal point');
      while (isDigit(text[pos])) pos++;
    }
    if (text[pos] === 'e' || text[pos] === 'E') {
      pos++;
      if (text[pos] === '+' || text[pos] === '-') pos++;
      if (!isDigit(text[pos])) fail('Expected exponent digits');
      while (isDigit(text[pos])) pos++;
    }
  };

  const literal = (word: string): void => {
    if (text.slice(pos, pos + word.length) !== word) fail('Unexpected token');
    pos += word.length;
  };

  const value = (): void => {
    ws();
    if (pos >= text.length) fail('Expected a JSON value', pos);
    const ch = text[pos];
    if (ch === '"') return string();
    if (ch === '{') return object();
    if (ch === '[') return array();
    if (ch === 't') return literal('true');
    if (ch === 'f') return literal('false');
    if (ch === 'n') return literal('null');
    if (ch === '-' || isDigit(ch)) return number();
    fail('Unexpected token');
  };

  const object = (): void => {
    pos++;
    ws();
    if (text[pos] === '}') { pos++; return; }
    while (true) {
      if (text[pos] !== '"') fail('Expected a property name');
      string();
      ws();
      if (text[pos] !== ':') fail("Expected ':' after property name");
      pos++;
      value();
      ws();
      if (text[pos] === '}') { pos++; return; }
      if (text[pos] !== ',') fail("Expected ',' or '}'");
      pos++;
      ws();
    }
  };

  const array = (): void => {
    pos++;
    ws();
    if (text[pos] === ']') { pos++; return; }
    while (true) {
      value();
      ws();
      if (text[pos] === ']') { pos++; return; }
      if (text[pos] !== ',') fail("Expected ',' or ']'");
      pos++;
      ws();
    }
  };

  ws();
  value();
  ws();
  if (pos !== text.length) fail('Unexpected content after JSON value');
}

function location(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** One Spec validation diagnostic this module actually PRODUCES — always a
 *  real `path`/`severity`/`code`/`message`. A strict superset of
 *  `SpecDiagnostic` (editor/spec-editor.types.ts's looser app-wide contract,
 *  which `state.ts`'s `SpecValidationService` pins): every field here is
 *  required where `SpecDiagnostic`'s is optional, so this type is directly
 *  assignable there without a cast. `keyword`/`schemaId` ride along from the
 *  canonical schema validator; `offset`/`line`/`column` only ever populate
 *  the single JSON-syntax diagnostic `parseSpecJson` produces. */
export interface SpecValidationDiagnostic {
  path: (string | number)[];
  severity: 'error' | 'warning';
  code: string;
  message: string;
  keyword?: string;
  schemaId?: string;
  offset?: number;
  line?: number;
  column?: number;
}

/** Parse arbitrary JSON with a deterministic syntax diagnostic. */
export function parseSpecJson(text: unknown): { value: unknown; diagnostic: SpecValidationDiagnostic | null } {
  const source = String(text ?? '');
  try {
    scanJson(source);
    return { value: JSON.parse(source), diagnostic: null };
  } catch (error) {
    const offset = error instanceof JsonSyntaxError ? error.offset : 0;
    return {
      value: null,
      diagnostic: {
        path: [], severity: 'error', code: 'invalid-json',
        message: error instanceof JsonSyntaxError ? error.message : 'Invalid JSON',
        offset, ...location(source, offset),
      },
    };
  }
}

/** The context handed to a registered Spec validator — a superset of
 *  `state.ts`'s `SpecValidationContext` (`sql`/`tab`/`query`, plus an open
 *  index signature): this module (src/core/) cannot import that type without
 *  a cycle (state.ts imports this module), so it declares its own honest,
 *  narrower-read contract here instead. `state.ts`'s `SpecValidationContext`
 *  is structurally assignable into this shape at every real call site. */
export interface SpecValidatorContext {
  sql?: string;
  [key: string]: unknown;
}

/** The arguments object a registered Spec validator receives — `value` is
 *  the value AT its registered `path` (or `undefined` when absent, see
 *  `present`), `root` is the complete Spec being validated. */
export interface SpecValidatorArgs {
  value: unknown;
  path: (string | number)[];
  root: unknown;
  present: boolean;
  context: SpecValidatorContext;
}

/** A single diagnostic (or diagnostic-shaped bag) a registered validator may
 *  return — looser than `SpecValidationDiagnostic` (this module's own
 *  produced shape): every field defaults when absent (`path` to the
 *  validator's own registered path, `severity` to `'error'`, `code` to
 *  `'invalid-spec'`), and `message` is coerced with `String(...)` regardless
 *  of its actual type — see `spec-schema.js`'s `createSpecValidationService`. */
export interface SpecValidatorDiagnosticInput {
  path?: (string | number)[];
  severity?: string;
  code?: string;
  message?: unknown;
  keyword?: string;
  [key: string]: unknown;
}

export type SpecValidatorResult = SpecValidatorDiagnosticInput | SpecValidatorDiagnosticInput[] | void;

export type SpecValidatorFn = (args: SpecValidatorArgs) => SpecValidatorResult;

/** One registered validator entry — an exact JSON path plus the function
 *  that validates the value found there (or its absence). */
export interface SpecValidatorEntry {
  path: (string | number)[];
  validate: SpecValidatorFn;
}

/** The canonical schema validation plus registered feature rules service
 *  (`spec-schema.js`'s `createSpecValidationService`, `query-spec`-bound). */
export interface QuerySpecValidationService {
  validate(spec: unknown, context?: SpecValidatorContext): SpecValidationDiagnostic[];
  /** Registers a validator at `path`; returns an unregister callback. */
  register(path: (string | number)[], validate: SpecValidatorFn): () => void;
}

// `spec-schema.js` is unconverted (checkJs:false) — a typed wrapper over the
// exact shape this module relies on (verified against the wrapped function
// body), same convention `param-type.ts` uses for `clickhouse-type.js`.
const createQuerySpecValidationService = _createQuerySpecValidationService as (
  initial?: readonly SpecValidatorEntry[]
) => QuerySpecValidationService;

// A custom guard rather than a bare `Array.isArray(validators)` check:
// `Array.isArray`'s built-in predicate narrows only to a MUTABLE `any[]`,
// which can't exclude `readonly SpecValidatorEntry[]` from the non-array
// branch of a `QuerySpecValidationService | readonly SpecValidatorEntry[]`
// union (a readonly array isn't assignable to a mutable one) — this explicit
// predicate narrows both branches correctly.
function isValidatorEntryList(value: unknown): value is readonly SpecValidatorEntry[] {
  return Array.isArray(value);
}

// Compatibility name for feature validators that predate the canonical
// schema. Known static fields now live exclusively in query-spec-v1.schema.json.
export const CORE_SPEC_VALIDATORS: readonly SpecValidatorEntry[] = Object.freeze([
  {
    path: ['dashboard', 'role'],
    validate: ({ value, context }: SpecValidatorArgs) => value === 'filter' ? filterSqlDiagnostics(context.sql) : [],
  },
  {
    path: ['timeRanges'],
    validate: ({ value }: SpecValidatorArgs) => {
      return hasSameTimeRangeParameter({ timeRanges: value })
        ? [{ path: ['timeRanges', 0, 'to'], code: 'time-range-same-parameter', message: 'Time-range From and To parameters must be different.' }]
        : [];
    },
  },
]);

export const defaultSpecValidationService: QuerySpecValidationService =
  createQuerySpecValidationService(CORE_SPEC_VALIDATORS);

/** Validate a parsed Spec through the canonical schema plus feature rules. */
export function validateSpec(
  spec: unknown,
  validators: QuerySpecValidationService | readonly SpecValidatorEntry[] = defaultSpecValidationService,
  context?: SpecValidatorContext,
): SpecValidationDiagnostic[] {
  const service = isValidatorEntryList(validators)
    ? createQuerySpecValidationService(validators)
    : validators;
  return service.validate(spec, context);
}

/**
 * Create an app-owned validator registry. Paths use string/number segments, so
 * array indexes and object keys containing dots remain unambiguous. register()
 * returns an unregister callback; no mutable module-global registry exists.
 */
export function createSpecValidatorRegistry(
  initial: readonly SpecValidatorEntry[] = CORE_SPEC_VALIDATORS,
): QuerySpecValidationService {
  return createQuerySpecValidationService(initial);
}

/** Parse and synchronously run semantic validation. */
export function evaluateSpecText(
  text: string,
  validators: QuerySpecValidationService | readonly SpecValidatorEntry[] = defaultSpecValidationService,
  context?: SpecValidatorContext,
): { parsed: unknown; diagnostics: SpecValidationDiagnostic[] } {
  const parsed = parseSpecJson(text);
  if (parsed.diagnostic) return { parsed: null, diagnostics: [parsed.diagnostic] };
  const diagnostics = !isValidatorEntryList(validators) && typeof validators.validate === 'function'
    ? validators.validate(parsed.value, context)
    : validateSpec(parsed.value, validators, context);
  return { parsed: parsed.value, diagnostics };
}

export const hasBlockingSpecErrors = (diagnostics: { severity?: string }[] = []): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

/** Normalize only settled known text fields; retain every extension and key order. */
export function normalizeSpec(spec: QuerySpecV1): QuerySpecV1 {
  const normalized = cloneJson(spec);
  if (typeof normalized.name === 'string') normalized.name = normalized.name.trim();
  if (typeof normalized.description === 'string') {
    normalized.description = normalized.description.trim();
    if (!normalized.description) delete normalized.description;
  }
  return normalized;
}

export const serializeSpec = (spec: QuerySpecV1): string => JSON.stringify(spec, null, 2);

/** Format syntactically-valid JSON without applying semantic normalization. */
export function formatSpecText(text: unknown): { text: string; diagnostic: SpecValidationDiagnostic | null } {
  const parsed = parseSpecJson(text);
  return parsed.diagnostic
    ? { text: String(text ?? ''), diagnostic: parsed.diagnostic }
    // `parsed.value` is arbitrary parsed JSON (any shape, not necessarily a
    // Spec object) — `serializeSpec` here is just a convenient `JSON.
    // stringify(..., null, 2)` wrapper, which behaves identically regardless
    // of shape.
    : { text: serializeSpec(parsed.value as QuerySpecV1), diagnostic: null };
}
