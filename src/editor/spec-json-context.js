// Tolerant JSON cursor context for Spec completion.  This deliberately does
// not use JSON.parse(): a completion request normally arrives while the user
// is halfway through a key or value.  The JSON Lezer tree is consulted to keep
// this adapter tied to the editor grammar; the small token walk below retains
// complete sibling values through Error nodes.

import { syntaxTree } from '@codemirror/language';

const isSpace = (ch) => /\s/.test(ch);
const isValueStart = (ch) => ch === '{' || ch === '[' || ch === '"'
  || ch === '-' || /[0-9tfn]/.test(ch || '');

function stringToken(text, start) {
  let i = start + 1;
  let escaped = false;
  for (; i < text.length; i += 1) {
    if (escaped) { escaped = false; continue; }
    if (text[i] === '\\') { escaped = true; continue; }
    if (text[i] === '"') return { end: i + 1, raw: text.slice(start + 1, i), complete: true };
  }
  return { end: text.length, raw: text.slice(start + 1), complete: false };
}

function primitiveToken(text, start) {
  let end = start;
  while (end < text.length && !/[\s,}\]]/.test(text[end])) end += 1;
  const raw = text.slice(start, end);
  let value;
  try { value = JSON.parse(raw); } catch { value = undefined; }
  return { end, raw, value, complete: value !== undefined };
}

function pushValue(frame, value) {
  if (!frame) return value;
  if (frame.kind === 'array') {
    frame.value[frame.index] = value;
    frame.index += 1;
    return value;
  }
  if (frame.kind === 'object' && frame.key != null) {
    frame.value[frame.key] = value; // assignment gives duplicate keys JSON.parse semantics
    return value;
  }
  return value;
}

function framePath(parent, key) {
  if (!parent) return [];
  if (parent.kind === 'array') return [...parent.path, parent.index];
  return parent.key == null ? parent.path : [...parent.path, parent.key];
}

/**
 * Resolve a completion context at `pos`.  The returned rootValue is only a
 * best-effort model made of complete tokens; callers must never persist it.
 */
export function specJsonContext(state, pos) {
  const text = state.doc.toString();
  const limit = Math.max(0, Math.min(pos, text.length));
  // Ask Lezer to parse the current document (including incomplete/Error nodes).
  // The walk intentionally owns recovery because Lezer omits malformed
  // siblings from the normal value tree.
  syntaxTree(state).resolveInner(limit, -1);

  const stack = [];
  let rootValue = {};
  let rootSet = false;
  let i = 0;
  let partial = '';
  let range = { from: limit, to: limit };
  let inPartialString = false;

  const current = () => stack.at(-1);
  const put = (value) => {
    const parent = current();
    if (!parent) { rootValue = value; rootSet = true; return value; }
    return pushValue(parent, value);
  };

  while (i < limit) {
    const ch = text[i];
    if (isSpace(ch)) { i += 1; continue; }
    const parent = current();
    if (ch === '{' || ch === '[') {
      const value = ch === '{' ? {} : [];
      const path = framePath(parent, parent?.kind === 'object' ? parent.key : undefined);
      put(value);
      stack.push({ kind: ch === '{' ? 'object' : 'array', value, path, key: null, index: 0, need: ch === '{' ? 'key' : 'value' });
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ']') { stack.pop(); i += 1; continue; }
    if (ch === ',') {
      if (parent?.kind === 'object') { parent.key = null; parent.need = 'key'; }
      if (parent?.kind === 'array') parent.need = 'value';
      i += 1;
      continue;
    }
    if (ch === ':') {
      if (parent?.kind === 'object') parent.need = 'value';
      i += 1;
      continue;
    }
    if (ch === '"') {
      const token = stringToken(text, i);
      const reachesCursor = token.end >= limit && !token.complete;
      if (reachesCursor) {
        partial = token.raw;
        range = { from: i + 1, to: limit };
        inPartialString = true;
        break;
      }
      let value;
      try { value = JSON.parse(text.slice(i, token.end)); } catch { value = token.raw; }
      if (parent?.kind === 'object' && parent.need === 'key') {
        parent.key = value;
        parent.need = 'colon';
      } else {
        put(value);
        if (parent?.kind === 'object') parent.need = 'comma';
        if (parent?.kind === 'array') parent.need = 'comma';
      }
      i = token.end;
      continue;
    }
    if (isValueStart(ch)) {
      const token = primitiveToken(text, i);
      if (token.end >= limit && token.raw && token.value === undefined) {
        partial = token.raw;
        range = { from: i, to: limit };
        break;
      }
      if (token.complete) {
        put(token.value);
        if (parent?.kind === 'object') parent.need = 'comma';
        if (parent?.kind === 'array') parent.need = 'comma';
      }
      i = Math.max(i + 1, token.end);
      continue;
    }
    i += 1; // recover from an Error node character without guessing its value
  }

  const frame = current();
  if (!frame) {
    return {
      path: [], positionKind: 'property-name', from: range.from, to: range.to,
      partial, existingKeys: [], rootValue: rootSet ? rootValue : {},
    };
  }
  if (frame.kind === 'object' && (frame.need === 'key' || (inPartialString && frame.need === 'key'))) {
    return {
      path: frame.path, positionKind: 'property-name', from: range.from, to: range.to,
      partial, existingKeys: Object.keys(frame.value), rootValue,
    };
  }
  if (frame.kind === 'object' && frame.key != null && (frame.need === 'value' || inPartialString || partial)) {
    return {
      path: [...frame.path, frame.key], positionKind: 'property-value', from: range.from, to: range.to,
      partial, existingKeys: Object.keys(frame.value), rootValue,
    };
  }
  if (frame.kind === 'array' && (frame.need === 'value' || inPartialString || partial)) {
    return {
      path: [...frame.path, frame.index], positionKind: 'array-item', from: range.from, to: range.to,
      partial, existingKeys: [], rootValue,
    };
  }
  return null;
}
