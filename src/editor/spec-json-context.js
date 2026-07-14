// Tolerant JSON cursor context for Spec completion. This module depends only
// on CodeMirror state/Lezer JSON: it never reads app state and its best-effort
// value is authoring assistance only (never validation or persistence input).

import { syntaxTree } from '@codemirror/language';

const VALUE_NAMES = new Set(['Object', 'Array', 'String', 'Number', 'True', 'False', 'Null']);
const INVALID = Symbol('invalid-json-subtree');

function children(node, namedOnly = false) {
  const out = [];
  const cursor = node.cursor();
  if (!cursor.firstChild()) return out;
  do {
    if (!namedOnly || !cursor.type.isAnonymous) out.push(cursor.node);
  } while (cursor.nextSibling());
  return out;
}

const namedChildren = (node) => children(node, true);

function decodedString(doc, node) {
  try { return JSON.parse(doc.sliceString(node.from, node.to)); } catch { return null; }
}

function directArrayValues(node) {
  let index = 0;
  const values = [];
  for (const child of children(node)) {
    if (child.name === ',') { index++; continue; }
    if (VALUE_NAMES.has(child.name)) values.push({ node: child, index });
  }
  return values;
}

function decodeNode(doc, node, omitted) {
  if (!node || node === omitted) return INVALID;
  if (node.name === 'Object') {
    const value = {};
    for (const property of namedChildren(node).filter((child) => child.name === 'Property')) {
      const parts = namedChildren(property);
      const name = parts.find((child) => child.name === 'PropertyName');
      const child = parts.find((part) => VALUE_NAMES.has(part.name));
      const key = name && decodedString(doc, name);
      const decoded = decodeNode(doc, child, omitted);
      if (typeof key === 'string' && decoded !== INVALID) value[key] = decoded;
    }
    return value;
  }
  if (node.name === 'Array') {
    const value = [];
    for (const item of directArrayValues(node)) {
      const decoded = decodeNode(doc, item.node, omitted);
      if (decoded !== INVALID) value[item.index] = decoded;
    }
    return value;
  }
  try { return JSON.parse(doc.sliceString(node.from, node.to)); } catch { return INVALID; }
}

function rootValueNode(state) {
  return namedChildren(syntaxTree(state).topNode).find((node) => VALUE_NAMES.has(node.name)) || null;
}

function containers(root, pos) {
  const found = [];
  const visit = (node) => {
    if (node.from <= pos && pos <= node.to && (node.name === 'Object' || node.name === 'Array')) found.push(node);
    for (const child of namedChildren(node)) {
      if (child.from <= pos && pos <= child.to) visit(child);
    }
  };
  if (root) visit(root);
  return found.sort((a, b) => (a.to - a.from) - (b.to - b.from));
}

function pathToNode(doc, root, target, path = []) {
  const same = (left, right) => left && right
    && left.name === right.name && left.from === right.from && left.to === right.to;
  if (same(root, target)) return path;
  if (root.name === 'Object') {
    for (const property of namedChildren(root).filter((child) => child.name === 'Property')) {
      const parts = namedChildren(property);
      const name = parts.find((child) => child.name === 'PropertyName');
      const value = parts.find((child) => VALUE_NAMES.has(child.name));
      const key = name && decodedString(doc, name);
      if (typeof key !== 'string' || !value) continue;
      const nested = pathToNode(doc, value, target, [...path, key]);
      if (nested) return nested;
    }
  } else if (root.name === 'Array') {
    for (const item of directArrayValues(root)) {
      const nested = pathToNode(doc, item.node, target, [...path, item.index]);
      if (nested) return nested;
    }
  }
  return null;
}

function objectProperties(doc, object) {
  return namedChildren(object).filter((child) => child.name === 'Property').map((property) => {
    const parts = namedChildren(property);
    const nameNode = parts.find((child) => child.name === 'PropertyName');
    return {
      property,
      nameNode,
      name: nameNode ? decodedString(doc, nameNode) : null,
      valueNode: parts.find((child) => VALUE_NAMES.has(child.name)) || null,
    };
  });
}

function stringPartial(doc, node, pos) {
  const start = node.from + 1;
  const raw = doc.sliceString(start, Math.max(start, Math.min(pos, node.to)));
  try { return JSON.parse(`"${raw}"`); } catch { return raw.replace(/\\(["\\/bfnrt])/g, '$1'); }
}

function incompleteQuotedRange(doc, node, pos) {
  if (!node || node.name !== '⚠' || node.from > pos || pos > node.to) return null;
  if (doc.sliceString(node.from, node.from + 1) !== '"') return null;
  return {
    from: node.from, to: node.to, quoted: true,
    partial: doc.sliceString(node.from + 1, pos).replace(/\\(["\\/bfnrt])/g, '$1'),
  };
}

function tokenRange(doc, pos, floor) {
  let from = pos;
  while (from > floor && /[A-Za-z0-9_.+-]/.test(doc.sliceString(from - 1, from))) from--;
  let to = pos;
  while (to < doc.length && /[A-Za-z0-9_.+-]/.test(doc.sliceString(to, to + 1))) to++;
  return { from, to, partial: doc.sliceString(from, pos), quoted: false };
}

function significantBefore(doc, pos, floor) {
  let at = pos - 1;
  while (at >= floor && /\s/.test(doc.sliceString(at, at + 1))) at--;
  return at >= floor ? { at, char: doc.sliceString(at, at + 1) } : { at: floor - 1, char: '' };
}

function significantAfter(doc, pos, ceiling) {
  let at = pos;
  while (at < ceiling && /\s/.test(doc.sliceString(at, at + 1))) at++;
  return at < ceiling ? { at, char: doc.sliceString(at, at + 1) } : { at: ceiling, char: '' };
}

function contextResult(base, root, doc, omitted) {
  return { ...base, rootValue: decodeNode(doc, root, omitted) };
}

/** Resolve the schema-relevant JSON authoring context at `pos`. */
export function specJsonContext(state, pos = state.selection.main.head) {
  const doc = state.doc;
  const at = Math.max(0, Math.min(pos, doc.length));
  const root = rootValueNode(state);
  if (!root) {
    if (!doc.toString().trim()) {
      return {
        path: [], positionKind: 'property-name', from: 0, to: doc.length,
        partial: '', quoted: false, existingKeys: [], existingItems: [],
        rootValue: {}, containerKind: 'root-empty',
      };
    }
    return { path: [], positionKind: 'none', from: at, to: at, partial: '', quoted: false, existingKeys: [], existingItems: [], rootValue: undefined };
  }

  const container = containers(root, at)[0];
  if (!container) {
    return { path: [], positionKind: 'none', from: at, to: at, partial: '', quoted: false, existingKeys: [], existingItems: [], rootValue: decodeNode(doc, root) };
  }
  const path = pathToNode(doc, root, container);

  if (container.name === 'Object') {
    const properties = objectProperties(doc, container);
    const currentName = properties.find(({ nameNode }) => nameNode && nameNode.from <= at && at <= nameNode.to);
    const existingKeys = properties.filter((entry) => entry !== currentName && typeof entry.name === 'string').map((entry) => entry.name);
    if (currentName) {
      const hasColon = children(currentName.property).some((child) => child.name === ':');
      return contextResult({
        path, positionKind: 'property-name', from: currentName.nameNode.from, to: currentName.nameNode.to,
        partial: stringPartial(doc, currentName.nameNode, at), quoted: true,
        existingKeys, existingItems: [], containerKind: 'object',
        editingExistingProperty: hasColon,
      }, root, doc, currentName.valueNode);
    }

    // Lezer represents an unterminated property name (`{"pa|`) as a direct
    // error child rather than PropertyName. Recover that quoted prefix without
    // treating arbitrary punctuation errors as key positions.
    const incompleteName = namedChildren(container)
      .map((child) => incompleteQuotedRange(doc, child, at)).find(Boolean);
    if (incompleteName) {
      return contextResult({
        path, positionKind: 'property-name', ...incompleteName,
        existingKeys, existingItems: [], containerKind: 'object',
        editingExistingProperty: false,
      }, root, doc, null);
    }

    const valueEntry = properties.find(({ name, nameNode, valueNode }) => {
      if (typeof name !== 'string' || !nameNode || nameNode.to > at) return false;
      if (valueNode && valueNode.from <= at && at <= valueNode.to) return true;
      if (valueNode) return false;
      const between = doc.sliceString(nameNode.to, at);
      return between.includes(':') && !between.includes(',');
    });
    if (valueEntry) {
      const node = valueEntry.valueNode;
      let range;
      if (node?.name === 'String' && node.from <= at && at <= node.to) {
        range = { from: node.from, to: node.to, partial: stringPartial(doc, node, at), quoted: true };
      } else if (node && node.from <= at && at <= node.to) {
        range = { from: node.from, to: node.to, partial: doc.sliceString(node.from, at), quoted: false };
      } else {
        range = tokenRange(doc, at, valueEntry.nameNode.to);
        const colon = doc.sliceString(valueEntry.nameNode.to, at).indexOf(':');
        let start = colon < 0 ? at : valueEntry.nameNode.to + colon + 1;
        while (start < at && /\s/.test(doc.sliceString(start, start + 1))) start++;
        if (doc.sliceString(start, start + 1) === '"') {
          range = {
            from: start, to: at, quoted: true,
            partial: doc.sliceString(start + 1, at).replace(/\\(["\\/bfnrt])/g, '$1'),
          };
        }
      }
      return contextResult({
        path: [...path, valueEntry.name], positionKind: 'property-value', ...range,
        existingKeys, existingItems: [], containerKind: 'object', explicitValueNode: !!node,
        objectRange: { from: container.from, to: container.to },
        objectIsSingleProperty: properties.length === 1,
        objectClosed: doc.sliceString(Math.max(container.from, container.to - 1), container.to) === '}',
      }, root, doc, node);
    }

    const before = significantBefore(doc, at, container.from);
    const after = significantAfter(doc, at, container.to);
    if (before.char === '{' || before.char === ',') {
      let from = at;
      let quoted = false;
      if (after.char === '"' && after.at === at) quoted = true;
      const prefixStart = doc.sliceString(before.at + 1, at).lastIndexOf('"');
      if (prefixStart >= 0) { from = before.at + 1 + prefixStart; quoted = true; }
      return contextResult({
        path, positionKind: 'property-name', from, to: at,
        partial: quoted ? doc.sliceString(from + 1, at) : '', quoted,
        existingKeys, existingItems: [], containerKind: 'object',
      }, root, doc, null);
    }
  } else {
    const values = directArrayValues(container);
    const current = values.find((item) => item.node.from <= at && at <= item.node.to);
    const incomplete = namedChildren(container)
      .map((child) => ({ node: child, range: incompleteQuotedRange(doc, child, at) }))
      .find((entry) => entry.range);
    const index = current?.index ?? children(container).filter((child) => child.name === ',' && child.to <= at).length;
    const existingItems = values.filter((item) => item !== current).map((item) => decodeNode(doc, item.node)).filter((value) => value !== INVALID);
    const before = significantBefore(doc, at, container.from);
    const valueAhead = !current && !incomplete
      && values.some((item) => item.index === index && item.node.from > at);
    if (!valueAhead && (current || incomplete || before.char === '[' || before.char === ',')) {
      const node = current?.node || incomplete?.node;
      let range;
      if (incomplete) range = incomplete.range;
      else if (node?.name === 'String') range = { from: node.from, to: node.to, partial: stringPartial(doc, node, at), quoted: true };
      else if (node) range = { from: node.from, to: node.to, partial: doc.sliceString(node.from, at), quoted: false };
      else range = tokenRange(doc, at, container.from + 1);
      return contextResult({
        path: [...path, index], positionKind: 'array-item', ...range,
        existingKeys: [], existingItems, containerKind: 'array', explicitValueNode: !!node,
      }, root, doc, node);
    }
  }

  return { path, positionKind: 'none', from: at, to: at, partial: '', quoted: false, existingKeys: [], existingItems: [], rootValue: decodeNode(doc, root) };
}
