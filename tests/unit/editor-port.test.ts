import { describe, it, expect } from 'vitest';
import { createNoopPort } from '../../src/editor/editor-port.js';

// The noop port is the headless-test stand-in for an editor adapter; every
// method must be callable (createApp wires consumers unconditionally) and
// return the interface's empty shape.
describe('createNoopPort', () => {
  it('implements every EditorPort method as a safe no-op', () => {
    const port = createNoopPort();
    expect(port.mount(document.createElement('div'))).toBeUndefined();
    expect(port.focus()).toBeUndefined();
    expect(port.hasFocus()).toBe(false);
    expect(port.getValue()).toBe('');
    expect(port.getSelection()).toEqual({ start: 0, end: 0, text: '' });
    expect(port.insertAtCursor('SELECT 1')).toBeUndefined();
    expect(port.replaceDocument('SELECT 2')).toBeUndefined();
    expect(port.revealOffset(3)).toBeUndefined();
    expect(port.syncFromState()).toBeUndefined();
    expect(port.refreshReference()).toBeUndefined();
    expect(port.destroy()).toBeUndefined();
  });
  it('onDocChange accepts a callback, never fires it, and returns an unsubscribe', () => {
    const port = createNoopPort();
    let fired = 0;
    const unsub = port.onDocChange(() => { fired++; });
    expect(typeof unsub).toBe('function');
    port.insertAtCursor('x');
    port.replaceDocument('y');
    expect(fired).toBe(0);
    expect(unsub()).toBeUndefined();
  });
});
