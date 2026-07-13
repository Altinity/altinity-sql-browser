// Pure saved-query Spec draft parsing, validation, normalization, and
// serialization. The workbench/editor layers own presentation and source
// markers; this module owns the deterministic data contract.

import { cloneJson, isPlainObject } from './saved-query.js';

const isDigit = (ch) => ch >= '0' && ch <= '9';
const isHex = (ch) => /[0-9a-f]/i.test(ch);
const isWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

class JsonSyntaxError extends Error {
  constructor(message, offset) {
    super(message);
    this.offset = offset;
  }
}

function scanJson(text) {
  let pos = 0;
  const fail = (message, at = pos) => { throw new JsonSyntaxError(message, at); };
  const ws = () => { while (pos < text.length && isWs(text[pos])) pos++; };

  const string = () => {
    if (text[pos] !== '"') fail('Expected a JSON string');
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

  const number = () => {
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

  const literal = (word) => {
    if (text.slice(pos, pos + word.length) !== word) fail('Unexpected token');
    pos += word.length;
  };

  const value = () => {
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

  const object = () => {
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

  const array = () => {
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

function location(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Parse arbitrary JSON with a deterministic syntax diagnostic. */
export function parseSpecJson(text) {
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

function atPath(root, path) {
  let value = root;
  for (const segment of path) {
    if (value == null || !Object.hasOwn(Object(value), segment)) return { present: false, value: undefined };
    value = value[segment];
  }
  return { present: true, value };
}

const typeRule = (path, type, code) => ({
  path,
  validate: ({ value, present }) => {
    if (!present) return [];
    const valid = type === 'object' ? isPlainObject(value) : typeof value === type;
    return valid ? [] : [{ path, severity: 'error', code, message: `${path.join('.')} must be ${type === 'object' ? 'an object' : `a ${type}`}` }];
  },
});

/** Initial known-field validators. Unknown fields deliberately pass through. */
export const CORE_SPEC_VALIDATORS = Object.freeze([
  typeRule(['name'], 'string', 'invalid-name-type'),
  {
    path: ['name'],
    validate: ({ value, present }) => present && typeof value === 'string' && !value.trim()
      ? [{ path: ['name'], severity: 'error', code: 'blank-name', message: 'name must not be blank' }]
      : [],
  },
  typeRule(['description'], 'string', 'invalid-description-type'),
  typeRule(['favorite'], 'boolean', 'invalid-favorite-type'),
  typeRule(['view'], 'string', 'invalid-view-type'),
  typeRule(['panel'], 'object', 'invalid-panel-type'),
  typeRule(['dashboard'], 'object', 'invalid-dashboard-type'),
]);

function invokeValidators(spec, validators) {
  const diagnostics = [];
  for (const entry of validators) {
    const path = Array.isArray(entry.path) ? entry.path : [];
    const ctx = { root: spec, path: [...path], ...atPath(spec, path) };
    const produced = entry.validate(ctx) || [];
    for (const diagnostic of Array.isArray(produced) ? produced : [produced]) {
      diagnostics.push({
        path: [...(diagnostic.path || path)],
        severity: diagnostic.severity || 'error',
        code: diagnostic.code || 'invalid-spec',
        message: String(diagnostic.message || 'Invalid Spec value'),
      });
    }
  }
  return diagnostics;
}

/** Validate a parsed Spec with a deterministic list of validator definitions. */
export function validateSpec(spec, validators = CORE_SPEC_VALIDATORS) {
  if (!isPlainObject(spec)) {
    return [{ path: [], severity: 'error', code: 'invalid-spec-root', message: 'Spec must be a JSON object' }];
  }
  return invokeValidators(spec, validators);
}

/**
 * Create an app-owned validator registry. Paths use string/number segments, so
 * array indexes and object keys containing dots remain unambiguous. register()
 * returns an unregister callback; no mutable module-global registry exists.
 */
export function createSpecValidatorRegistry(initial = CORE_SPEC_VALIDATORS) {
  const entries = [...initial];
  return {
    register(path, validate) {
      const entry = { path: [...path], validate };
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    validate: (spec) => validateSpec(spec, entries),
  };
}

/** Parse and synchronously run semantic validation. */
export function evaluateSpecText(text, validators = CORE_SPEC_VALIDATORS) {
  const parsed = parseSpecJson(text);
  if (parsed.diagnostic) return { parsed: null, diagnostics: [parsed.diagnostic] };
  const diagnostics = validators && typeof validators.validate === 'function'
    ? validators.validate(parsed.value)
    : validateSpec(parsed.value, validators);
  return { parsed: parsed.value, diagnostics };
}

export const hasBlockingSpecErrors = (diagnostics = []) =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

/** Normalize only settled known text fields; retain every extension and key order. */
export function normalizeSpec(spec) {
  const normalized = cloneJson(spec);
  if (typeof normalized.name === 'string') normalized.name = normalized.name.trim();
  if (typeof normalized.description === 'string') {
    normalized.description = normalized.description.trim();
    if (!normalized.description) delete normalized.description;
  }
  return normalized;
}

export const serializeSpec = (spec) => JSON.stringify(spec, null, 2);

/** Format syntactically-valid JSON without applying semantic normalization. */
export function formatSpecText(text) {
  const parsed = parseSpecJson(text);
  return parsed.diagnostic
    ? { text: String(text ?? ''), diagnostic: parsed.diagnostic }
    : { text: serializeSpec(parsed.value), diagnostic: null };
}
