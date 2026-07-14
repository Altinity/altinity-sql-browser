import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { specJsonContext } from '../../src/editor/spec-json-context.js';

const context = (doc, pos = doc.length) => specJsonContext(EditorState.create({ doc, extensions: [json()] }), pos);

describe('specJsonContext', () => {
  it('offers root properties in an empty document and root object', () => {
    expect(context('')).toMatchObject({ path: [], positionKind: 'property-name', from: 0, to: 0, existingKeys: [] });
    expect(context('{')).toMatchObject({ path: [], positionKind: 'property-name', from: 1, to: 1, rootValue: {} });
  });

  it('tracks partial property names and exact replacement ranges', () => {
    const doc = '{\n  "pan';
    expect(context(doc)).toMatchObject({ path: [], positionKind: 'property-name', partial: 'pan', from: 5, to: 8 });
  });

  it('resolves nested value and array contexts while retaining complete siblings', () => {
    const doc = '{"panel":{"cfg":{"type":"logs","msg": "me';
    expect(context(doc)).toMatchObject({
      path: ['panel', 'cfg', 'msg'], positionKind: 'property-value', partial: 'me',
      existingKeys: ['type'], rootValue: { panel: { cfg: { type: 'logs' } } },
    });
    expect(context('{"panel":{"cfg":{"y":[1, ')).toMatchObject({
      path: ['panel', 'cfg', 'y', 1], positionKind: 'array-item', existingKeys: [],
    });
  });

  it('uses last complete duplicate keys, dotted keys, and numeric array paths', () => {
    const doc = '{"a.b":[{"type":"old"},{"type":"new"}],"a.b":[{"type":"last"}],';
    const result = context(doc);
    expect(result.path).toEqual([]);
    expect(result.rootValue).toEqual({ 'a.b': [{ type: 'last' }] });
    expect(context('{"a.b":[{"x":1},')).toMatchObject({ path: ['a.b', 1], positionKind: 'array-item' });
  });

  it('handles primitive partials and recovers after malformed text without inventing a value', () => {
    expect(context('{"favorite": tr')).toMatchObject({
      path: ['favorite'], positionKind: 'property-value', partial: 'tr', from: 13, to: 15,
    });
    expect(context('{"panel": @, "view": ')).toMatchObject({
      path: ['view'], positionKind: 'property-value', existingKeys: [], rootValue: {},
    });
  });

  it('keeps complete scalar values and recognizes explicit null/booleans', () => {
    const result = context('{"favorite":false,"key":null,');
    expect(result.rootValue).toEqual({ favorite: false, key: null });
    expect(result.existingKeys).toEqual(['favorite', 'key']);
  });

  it('handles root primitives, closed containers, keyless recovery, and quiet positions', () => {
    expect(context('true')).toMatchObject({ rootValue: true, path: [] });
    expect(context('{}')).toMatchObject({ rootValue: {}, path: [] });
    expect(context('{"key" 1,')).toMatchObject({ path: [], positionKind: 'property-name', rootValue: {} });
    expect(context('{1,')).toMatchObject({ path: [], positionKind: 'property-name' });
    expect(context('{"key":1')).toBeNull();
  });
});
