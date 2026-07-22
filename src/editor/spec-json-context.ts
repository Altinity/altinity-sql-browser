// Tolerant JSON cursor context for Spec completion. This module depends only
// on CodeMirror state/Lezer JSON: it never reads app state and its best-effort
// value is authoring assistance only (never validation or persistence input).

import type { EditorState, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';

/** A JSON value as tolerantly decoded from the (possibly incomplete) document. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One path segment: an object key or an array index. */
export type JsonPathSegment = string | number;

/** What kind of authoring position the cursor sits at. */
export type PositionKind = 'property-name' | 'property-value' | 'array-item' | 'none';

/** What kind of container the cursor's innermost enclosing node is. */
export type ContainerKind = 'root-empty' | 'object' | 'array';

/** The schema-relevant JSON authoring context `specJsonContext` resolves at a position. */
export interface SpecJsonContext {
  path: JsonPathSegment[];
  positionKind: PositionKind;
  from: number;
  to: number;
  partial: string;
  quoted: boolean;
  existingKeys: string[];
  existingItems: JsonValue[];
  rootValue?: JsonValue;
  containerKind?: ContainerKind;
  editingExistingProperty?: boolean;
  objectRange?: { from: number; to: number };
  objectIsSingleProperty?: boolean;
  objectClosed?: boolean;
  explicitValueNode?: boolean;
}

const VALUE_NAMES = new Set(['Object', 'Array', 'String', 'Number', 'True', 'False', 'Null']);
const INVALID = Symbol('invalid-json-subtree');

/** A from/to/partial/quoted text range — the shared shape of every "cursor sits
 *  inside this token" result below (a JSON token or a tolerant token-ish prefix). */
interface TextRange {
  from: number;
  to: number;
  partial: string;
  quoted: boolean;
}

function children(node: SyntaxNode, namedOnly = false): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const cursor = node.cursor();
  if (!cursor.firstChild()) return out;
  do {
    if (!namedOnly || !cursor.type.isAnonymous) out.push(cursor.node);
  } while (cursor.nextSibling());
  return out;
}

const namedChildren = (node: SyntaxNode): SyntaxNode[] => children(node, true);

function decodedString(doc: Text, node: SyntaxNode): string | null {
  try { return JSON.parse(doc.sliceString(node.from, node.to)); } catch { return null; }
}

function directArrayValues(node: SyntaxNode): { node: SyntaxNode; index: number }[] {
  let index = 0;
  const values: { node: SyntaxNode; index: number }[] = [];
  for (const child of children(node)) {
    if (child.name === ',') { index++; continue; }
    if (VALUE_NAMES.has(child.name)) values.push({ node: child, index });
  }
  return values;
}

function decodeNode(doc: Text, node: SyntaxNode | null | undefined, omitted?: SyntaxNode | null): JsonValue | typeof INVALID {
  if (!node || node === omitted) return INVALID;
  if (node.name === 'Object') {
    const value: { [key: string]: JsonValue } = {};
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
    const value: JsonValue[] = [];
    for (const item of directArrayValues(node)) {
      const decoded = decodeNode(doc, item.node, omitted);
      if (decoded !== INVALID) value[item.index] = decoded;
    }
    return value;
  }
  // Lezer only classifies complete, valid JSON primitives as VALUE_NAMES;
  // malformed scalar fragments are error nodes and never reach this branch.
  return JSON.parse(doc.sliceString(node.from, node.to)) as JsonValue;
}

function rootValueNode(state: EditorState): SyntaxNode | null {
  return namedChildren(syntaxTree(state).topNode).find((node) => VALUE_NAMES.has(node.name)) || null;
}

function containers(root: SyntaxNode | null, pos: number): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.from <= pos && pos <= node.to && (node.name === 'Object' || node.name === 'Array')) found.push(node);
    for (const child of namedChildren(node)) {
      if (child.from <= pos && pos <= child.to) visit(child);
    }
  };
  if (root) visit(root);
  return found.sort((a, b) => (a.to - a.from) - (b.to - b.from));
}

function pathToNode(doc: Text, root: SyntaxNode, target: SyntaxNode, path: JsonPathSegment[] = []): JsonPathSegment[] | null {
  const same = (left: SyntaxNode | null | undefined, right: SyntaxNode | null | undefined): boolean => !!left && !!right
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

interface ObjectProperty {
  property: SyntaxNode;
  nameNode: SyntaxNode | undefined;
  name: string | null;
  valueNode: SyntaxNode | null;
}

function objectProperties(doc: Text, object: SyntaxNode): ObjectProperty[] {
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

function stringPartial(doc: Text, node: SyntaxNode, pos: number): string {
  const start = node.from + 1;
  const raw = doc.sliceString(start, Math.max(start, Math.min(pos, node.to)));
  try { return JSON.parse(`"${raw}"`); } catch { return raw.replace(/\\(["\\/bfnrt])/g, '$1'); }
}

function incompleteQuotedRange(doc: Text, node: SyntaxNode, pos: number): TextRange | null {
  if (!node || node.name !== '⚠' || node.from > pos || pos > node.to) return null;
  if (doc.sliceString(node.from, node.from + 1) !== '"') return null;
  return {
    from: node.from, to: node.to, quoted: true,
    partial: doc.sliceString(node.from + 1, pos).replace(/\\(["\\/bfnrt])/g, '$1'),
  };
}

function tokenRange(doc: Text, pos: number, floor: number): TextRange {
  let from = pos;
  while (from > floor && /[A-Za-z0-9_.+-]/.test(doc.sliceString(from - 1, from))) from--;
  let to = pos;
  while (to < doc.length && /[A-Za-z0-9_.+-]/.test(doc.sliceString(to, to + 1))) to++;
  return { from, to, partial: doc.sliceString(from, pos), quoted: false };
}

function significantBefore(doc: Text, pos: number, floor: number): { at: number; char: string } {
  let at = pos - 1;
  while (at >= floor && /\s/.test(doc.sliceString(at, at + 1))) at--;
  return at >= floor ? { at, char: doc.sliceString(at, at + 1) } : { at: floor - 1, char: '' };
}

function contextResult(
  base: Omit<SpecJsonContext, 'rootValue'>,
  root: SyntaxNode,
  doc: Text,
  omitted?: SyntaxNode | null,
): SpecJsonContext {
  // `decodeNode`'s `typeof INVALID` branch is unreachable here (`root` is
  // always a real node distinct from `omitted`) — an erased cast, not a new
  // runtime check, keeps that guarantee out of the return type without adding
  // a branch this call site can never exercise.
  return { ...base, rootValue: decodeNode(doc, root, omitted) as JsonValue };
}

/** Resolve the schema-relevant JSON authoring context at `pos`. */
export function specJsonContext(state: EditorState, pos: number = state.selection.main.head): SpecJsonContext {
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
    return { path: [], positionKind: 'none', from: at, to: at, partial: '', quoted: false, existingKeys: [], existingItems: [], rootValue: decodeNode(doc, root) as JsonValue };
  }
  // `container` is always found within `root` (it came from `containers(root, at)`),
  // so `pathToNode` always resolves — an erased assertion, not a runtime fallback.
  const path = pathToNode(doc, root, container)!;

  if (container.name === 'Object') {
    const properties = objectProperties(doc, container);
    const currentName = properties.find(({ nameNode }) => nameNode && nameNode.from <= at && at <= nameNode.to);
    const existingKeys = properties.filter((entry) => entry !== currentName && typeof entry.name === 'string').map((entry) => entry.name as string);
    if (currentName) {
      const hasColon = children(currentName.property).some((child) => child.name === ':');
      return contextResult({
        path, positionKind: 'property-name', from: currentName.nameNode!.from, to: currentName.nameNode!.to,
        partial: stringPartial(doc, currentName.nameNode!, at), quoted: true,
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
      let range: TextRange;
      if (node?.name === 'String' && node.from <= at && at <= node.to) {
        range = { from: node.from, to: node.to, partial: stringPartial(doc, node, at), quoted: true };
      } else if (node && node.from <= at && at <= node.to) {
        range = { from: node.from, to: node.to, partial: doc.sliceString(node.from, at), quoted: false };
      } else {
        range = tokenRange(doc, at, valueEntry.nameNode!.to);
        const colon = doc.sliceString(valueEntry.nameNode!.to, at).indexOf(':');
        let start = colon < 0 ? at : valueEntry.nameNode!.to + colon + 1;
        while (start < at && /\s/.test(doc.sliceString(start, start + 1))) start++;
        if (doc.sliceString(start, start + 1) === '"') {
          range = {
            from: start, to: at, quoted: true,
            partial: doc.sliceString(start + 1, at).replace(/\\(["\\/bfnrt])/g, '$1'),
          };
        }
      }
      return contextResult({
        path: [...path, valueEntry.name as string], positionKind: 'property-value', ...range,
        existingKeys, existingItems: [], containerKind: 'object', explicitValueNode: !!node,
        objectRange: { from: container.from, to: container.to },
        objectIsSingleProperty: properties.length === 1,
        objectClosed: doc.sliceString(Math.max(container.from, container.to - 1), container.to) === '}',
      }, root, doc, node);
    }

    const before = significantBefore(doc, at, container.from);
    if (before.char === '{' || before.char === ',') {
      return contextResult({
        path, positionKind: 'property-name', from: at, to: at,
        partial: '', quoted: false,
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
    const existingItems = values.filter((item) => item !== current)
      .map((item) => decodeNode(doc, item.node))
      .filter((value): value is JsonValue => value !== INVALID);
    const before = significantBefore(doc, at, container.from);
    const valueAhead = !current && !incomplete
      && values.some((item) => item.index === index && item.node.from > at);
    if (!valueAhead && (current || incomplete || before.char === '[' || before.char === ',')) {
      const node = current?.node || incomplete?.node;
      let range: TextRange;
      if (incomplete) range = incomplete.range!;
      else if (node?.name === 'String') range = { from: node.from, to: node.to, partial: stringPartial(doc, node, at), quoted: true };
      else if (node) range = { from: node.from, to: node.to, partial: doc.sliceString(node.from, at), quoted: false };
      else range = tokenRange(doc, at, container.from + 1);
      return contextResult({
        path: [...path, index], positionKind: 'array-item', ...range,
        existingKeys: [], existingItems, containerKind: 'array', explicitValueNode: !!node,
      }, root, doc, node);
    }
  }

  return { path, positionKind: 'none', from: at, to: at, partial: '', quoted: false, existingKeys: [], existingItems: [], rootValue: decodeNode(doc, root) as JsonValue };
}
