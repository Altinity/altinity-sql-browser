// Codec-level JSON resource guards (#280 "Resource limits"): UTF-8 byte size
// is enforced BEFORE parsing, maximum container depth is enforced by a
// string scan BEFORE parsing (so a nesting bomb never reaches JSON.parse),
// and the same byte counter re-checks normalized serialized sizes after
// encoding. Pure — no TextEncoder or other environment globals.

import { PORTABLE_LIMITS } from './portable-limits.js';
import { diagnostic } from './workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from './workspace-diagnostics.js';

/** UTF-8 byte length of `text`, matching the WHATWG TextEncoder contract
 *  (an unpaired surrogate encodes as U+FFFD — three bytes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next < 0xe000) {
        bytes += 4;
        index += 1;
      } else bytes += 3; // unpaired high surrogate → U+FFFD
    } else bytes += 3; // BMP ≥ U+0800, incl. unpaired low surrogates → U+FFFD
  }
  return bytes;
}

/** Maximum container ({}/[]) nesting depth of raw JSON text, string-aware
 *  (braces inside string literals are data). The scan is resilient to
 *  malformed text — syntax errors are JSON.parse's job, not this counter's. */
export function scanJsonDepth(text: string): number {
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
    } else if (ch === '}' || ch === ']') depth -= 1;
  }
  return maxDepth;
}

export interface JsonLimitOptions {
  maxBytes?: number;
  maxDepth?: number;
}

export type ParseJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/** Parse untrusted JSON text with the #280 codec guards applied in order:
 *  UTF-8 byte size before parsing, container depth before parsing, then
 *  JSON.parse. */
export function parseJsonWithLimits(text: unknown, {
  maxBytes = PORTABLE_LIMITS.maxDecodedJsonBytes,
  maxDepth = PORTABLE_LIMITS.maxJsonDepth,
}: JsonLimitOptions = {}): ParseJsonResult {
  if (typeof text !== 'string') {
    return { ok: false, diagnostics: [diagnostic([], 'json-syntax', 'Not a valid JSON file')] };
  }
  const bytes = utf8ByteLength(text);
  if (bytes > maxBytes) {
    return {
      ok: false,
      diagnostics: [diagnostic([], 'limit-json-bytes',
        `Document is ${bytes} UTF-8 bytes; the maximum is ${maxBytes}`)],
    };
  }
  const depth = scanJsonDepth(text);
  if (depth > maxDepth) {
    return {
      ok: false,
      diagnostics: [diagnostic([], 'limit-json-depth',
        `Document nests ${depth} levels deep; the maximum is ${maxDepth}`)],
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, diagnostics: [diagnostic([], 'json-syntax', 'Not a valid JSON file')] };
  }
}
