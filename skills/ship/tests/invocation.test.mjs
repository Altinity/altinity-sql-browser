import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShipInvocation } from '../references/parse-invocation.mjs';

test('existing /ship invocations retain the fable planner default', () => {
  assert.deepEqual(parseShipInvocation('/ship 447'), { scope: '447', planner: 'fable' });
  assert.deepEqual(parseShipInvocation('447.2 unattended'), { scope: '447.2', planner: 'fable' });
  assert.deepEqual(parseShipInvocation('/ship 424,425'), { scope: '424,425', planner: 'fable' });
});

test('the ChatGPT planner is selected explicitly', () => {
  assert.deepEqual(parseShipInvocation('/ship 447 --planner chatgpt'), { scope: '447', planner: 'chatgpt' });
  assert.deepEqual(parseShipInvocation('447 --planner fable'), { scope: '447', planner: 'fable' });
});

test('invalid planner and scope arguments fail closed', () => {
  for (const input of ['/ship', '/ship nope', '/ship 1.2,3', '/ship 1 --planner', '/ship 1 --planner other', '/ship 1 --planner chatgpt --planner fable', '/ship 1 --wat']) {
    assert.throws(() => parseShipInvocation(input));
  }
});
