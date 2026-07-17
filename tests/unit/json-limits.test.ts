import { describe, expect, it } from 'vitest';
import {
  parseJsonWithLimits, scanJsonDepth, utf8ByteLength,
} from '../../src/dashboard/model/json-limits.js';
import { PORTABLE_LIMITS } from '../../src/dashboard/model/portable-limits.js';

describe('utf8ByteLength', () => {
  it('counts bytes per WHATWG TextEncoder, incl. surrogate handling', () => {
    const encoder = new TextEncoder();
    for (const sample of ['', 'ascii', 'é', 'ü2', '€', 'a€b', '😀', 'x😀y', '中文字']) {
      expect(utf8ByteLength(sample)).toBe(encoder.encode(sample).length);
    }
    // Unpaired high surrogate → U+FFFD (3 bytes); high surrogate at EOS.
    expect(utf8ByteLength('\uD800')).toBe(3);
    expect(utf8ByteLength('\uD800x')).toBe(3 + 1);
    // Lone low surrogate → U+FFFD (3 bytes).
    expect(utf8ByteLength('\uDC00')).toBe(3);
  });
});

describe('scanJsonDepth', () => {
  it('measures max container nesting, ignoring braces inside strings', () => {
    expect(scanJsonDepth('1')).toBe(0);
    expect(scanJsonDepth('{}')).toBe(1);
    expect(scanJsonDepth('{"a":[1,2]}')).toBe(2);
    expect(scanJsonDepth('[[[]]]')).toBe(3);
    expect(scanJsonDepth('{"a":"}}}}","b":{"c":1}}')).toBe(2);
    // Escaped quote inside a string keeps the string open; braces stay data.
    expect(scanJsonDepth('{"a":"x\\"{{{"}')).toBe(1);
    // Backslash-escaped backslash then closing quote ends the string.
    expect(scanJsonDepth('{"a":"x\\\\"}')).toBe(1);
  });
});

describe('parseJsonWithLimits', () => {
  it('parses valid JSON within limits', () => {
    expect(parseJsonWithLimits('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('rejects non-string input and JSON syntax errors with a stable diagnostic', () => {
    expect(parseJsonWithLimits(42)).toEqual({
      ok: false,
      diagnostics: [{ path: [], severity: 'error', code: 'json-syntax', message: 'Not a valid JSON file' }],
    });
    expect(parseJsonWithLimits('{bad')).toEqual({
      ok: false,
      diagnostics: [{ path: [], severity: 'error', code: 'json-syntax', message: 'Not a valid JSON file' }],
    });
  });

  it('enforces the UTF-8 byte cap before parsing, at boundary and boundary+1', () => {
    const atLimit = '"' + 'a'.repeat(8) + '"'; // 10 bytes
    expect(parseJsonWithLimits(atLimit, { maxBytes: 10 })).toEqual({ ok: true, value: 'aaaaaaaa' });
    const overLimit = '"' + 'a'.repeat(9) + '"'; // 11 bytes
    const result = parseJsonWithLimits(overLimit, { maxBytes: 10 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics[0].code).toBe('limit-json-bytes');
    expect(!result.ok && result.diagnostics[0].message).toContain('11 UTF-8 bytes');
  });

  it('enforces the depth cap before parsing, at boundary and boundary+1', () => {
    const atDepth = '[[[1]]]'; // depth 3
    expect(parseJsonWithLimits(atDepth, { maxDepth: 3 })).toEqual({ ok: true, value: [[[1]]] });
    const overDepth = '[[[[1]]]]'; // depth 4
    const result = parseJsonWithLimits(overDepth, { maxDepth: 3 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics[0].code).toBe('limit-json-depth');
    expect(!result.ok && result.diagnostics[0].message).toContain('4 levels');
  });

  it('defaults to the #280 portable limits', () => {
    // A byte-cap breach uses the default maxDecodedJsonBytes message.
    const huge = '"' + 'a'.repeat(PORTABLE_LIMITS.maxDecodedJsonBytes) + '"';
    const result = parseJsonWithLimits(huge);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics[0].code).toBe('limit-json-bytes');
  });
});
