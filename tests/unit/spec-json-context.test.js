import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { specJsonContext } from '../../src/editor/spec-json-context.js';

function at(source) {
  const pos = source.indexOf('|');
  const doc = source.slice(0, pos) + source.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [json()] });
  return { doc, pos, context: specJsonContext(state, pos) };
}

describe('tolerant Spec JSON cursor context', () => {
  it('offers root properties for an empty or whitespace-only document', () => {
    expect(at('|').context).toMatchObject({
      path: [], positionKind: 'property-name', from: 0, to: 0,
      partial: '', rootValue: {}, containerKind: 'root-empty',
    });
    expect(at('  | ').context).toMatchObject({ positionKind: 'property-name', from: 0, to: 3 });
  });

  it('resolves empty and partial quoted object keys with existing siblings', () => {
    expect(at('{|}').context).toMatchObject({
      path: [], positionKind: 'property-name', partial: '', existingKeys: [], rootValue: {},
    });
    const partial = at('{"name":"Q","pa|"}').context;
    expect(partial).toMatchObject({
      path: [], positionKind: 'property-name', partial: 'pa', quoted: true,
      existingKeys: ['name'], rootValue: { name: 'Q' },
    });
    expect(partial.to - partial.from).toBe(4);
    expect(at('{"pa|').context).toMatchObject({
      path: [], positionKind: 'property-name', partial: 'pa', quoted: true, rootValue: {},
    });
    expect(at('{"panel":{"c|').context).toMatchObject({
      path: ['panel'], positionKind: 'property-name', partial: 'c', quoted: true,
      rootValue: { panel: {} },
    });
  });

  it('resolves values after a colon and inside quoted or primitive prefixes', () => {
    expect(at('{"favorite": |}').context).toMatchObject({
      path: ['favorite'], positionKind: 'property-value', partial: '', rootValue: {},
    });
    expect(at('{"view":"p|"}').context).toMatchObject({
      path: ['view'], positionKind: 'property-value', partial: 'p', quoted: true, rootValue: {},
    });
    expect(at('{"favorite": fa|}').context).toMatchObject({
      path: ['favorite'], positionKind: 'property-value', partial: 'fa', quoted: false,
    });
  });

  it('retains completed siblings in incomplete nested objects for discrimination', () => {
    const context = at('{"panel":{"cfg":{"type":"line","x": |').context;
    expect(context).toMatchObject({
      path: ['panel', 'cfg', 'x'], positionKind: 'property-value',
      rootValue: { panel: { cfg: { type: 'line' } } },
    });
  });

  it('preserves dotted keys, array indexes, existing items, and last duplicate wins', () => {
    const context = at('{"a.b":{"items":[0,2, |]},"type":"bar","type":"line"}').context;
    expect(context).toMatchObject({
      path: ['a.b', 'items', 2], positionKind: 'array-item', existingItems: [0, 2],
      rootValue: { 'a.b': { items: [0, 2] }, type: 'line' },
    });
  });

  it('reports quiet contexts outside a JSON authoring position', () => {
    expect(at('{}|').context.positionKind).toBe('none');
    expect(at('{} |').context.positionKind).toBe('none');
    expect(at('{"x":true |}').context.positionKind).toBe('none');
    expect(at('{:|}').context.positionKind).toBe('none');
    expect(at('no-json|').context.positionKind).toBe('none');
    expect(at('[| 1]').context.positionKind).toBe('none');
  });

  it('walks nested array/object paths and resolves active scalar array values', () => {
    expect(at('{"a":[{}],"b":[{}, {"c":[|]}]}').context).toMatchObject({
      path: ['b', 1, 'c', 0], positionKind: 'array-item',
    });
    expect(at('{"x":1|}').context).toMatchObject({
      path: ['x'], positionKind: 'property-value', partial: '1', quoted: false,
    });
    expect(at('["p|"]').context).toMatchObject({
      path: [0], positionKind: 'array-item', partial: 'p', quoted: true,
    });
    expect(at('[1|]').context).toMatchObject({
      path: [0], positionKind: 'array-item', partial: '1', quoted: false,
    });
  });

  it('ignores malformed siblings and tolerates incomplete escape prefixes', () => {
    expect(at('{"bad": tru, "ok":{|}}').context).toMatchObject({
      path: ['ok'], positionKind: 'property-name', rootValue: { ok: {} },
    });
    expect(at('{"view":"\\|"}').context).toMatchObject({
      path: ['view'], positionKind: 'property-value', quoted: true,
    });
  });
});
