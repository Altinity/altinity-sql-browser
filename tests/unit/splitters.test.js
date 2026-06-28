import { describe, it, expect, vi } from 'vitest';
import { dragValue, startDrag } from '../../src/ui/splitters.js';

describe('dragValue', () => {
  const rect = { top: 100, bottom: 300 }; // height 200
  it('col clamps clientX to [180,420]', () => {
    expect(dragValue('col', { clientX: 50 })).toBe(180);
    expect(dragValue('col', { clientX: 250 })).toBe(250);
    expect(dragValue('col', { clientX: 999 })).toBe(420);
  });
  it('col divides clientX by the zoom scale before clamping', () => {
    expect(dragValue('col', { clientX: 360 }, null, 1.2)).toBe(300); // 360 visual px → 300 layout px
    expect(dragValue('col', { clientX: 60 }, null, 1.2)).toBe(180); // 50 layout → clamp to 180
  });
  it('sideRow maps Y to % clamped [25,85]', () => {
    expect(dragValue('sideRow', { clientY: 200 }, rect)).toBe(50);
    expect(dragValue('sideRow', { clientY: 100 }, rect)).toBe(25); // 0% → clamp 25
    expect(dragValue('sideRow', { clientY: 300 }, rect)).toBe(85); // 100% → clamp 85
  });
  it('row maps Y to % clamped [15,85]', () => {
    expect(dragValue('row', { clientY: 100 }, rect)).toBe(15);
    expect(dragValue('row', { clientY: 200 }, rect)).toBe(50);
  });
});

function fakeWin() {
  const handlers = {};
  return {
    addEventListener: (t, fn) => { handlers[t] = fn; },
    removeEventListener: vi.fn((t) => { delete handlers[t]; }),
    _fire: (t, ev) => handlers[t] && handlers[t](ev),
    _has: (t) => !!handlers[t],
  };
}

describe('startDrag', () => {
  function harness(axis) {
    const win = fakeWin();
    const handle = document.createElement('div');
    const state = { sidebarPx: 0, sideSplitPct: 0, editorPct: 0 };
    const apply = vi.fn();
    const save = vi.fn();
    const ctx = { win, state, apply, save, rectFor: () => ({ top: 0, bottom: 100 }) };
    const ev = { preventDefault: vi.fn(), currentTarget: handle };
    startDrag(ev, axis, ctx);
    return { win, handle, state, apply, save, ev };
  }

  it('col: drag updates sidebarPx + persists on mouseup', () => {
    const { win, handle, state, apply, save } = harness('col');
    expect(handle.classList.contains('dragging')).toBe(true);
    win._fire('mousemove', { clientX: 300 });
    expect(state.sidebarPx).toBe(300);
    expect(apply).toHaveBeenCalledWith('col', 300);
    win._fire('mouseup');
    expect(handle.classList.contains('dragging')).toBe(false);
    expect(save).toHaveBeenCalledWith('sidebarPx', 300);
    expect(win._has('mousemove')).toBe(false);
  });
  it('col: applies ctx.scale to the dragged width', () => {
    const win = fakeWin();
    const handle = document.createElement('div');
    const state = { sidebarPx: 0 };
    const apply = vi.fn();
    const ctx = { win, state, apply, save: vi.fn(), rectFor: () => ({}), scale: () => 1.2 };
    startDrag({ preventDefault: vi.fn(), currentTarget: handle }, 'col', ctx);
    win._fire('mousemove', { clientX: 360 });
    expect(state.sidebarPx).toBe(300); // 360 / 1.2
    expect(apply).toHaveBeenCalledWith('col', 300);
  });
  it('sideRow: updates sideSplitPct + persists', () => {
    const { win, state, save } = harness('sideRow');
    win._fire('mousemove', { clientY: 50 });
    expect(state.sideSplitPct).toBe(50);
    win._fire('mouseup');
    expect(save).toHaveBeenCalledWith('sideSplitPct', 50);
  });
  it('row: updates editorPct + persists', () => {
    const { win, state, save } = harness('row');
    win._fire('mousemove', { clientY: 50 });
    expect(state.editorPct).toBe(50);
    win._fire('mouseup');
    expect(save).toHaveBeenCalledWith('editorPct', 50);
  });
  it('defaults win to global window when ctx.win is absent', () => {
    const handle = document.createElement('div');
    const ev = { preventDefault: vi.fn(), currentTarget: handle };
    const ctx = { state: {}, apply: vi.fn(), save: vi.fn(), rectFor: () => ({ top: 0, bottom: 1 }) };
    startDrag(ev, 'col', ctx);
    expect(handle.classList.contains('dragging')).toBe(true);
    window.dispatchEvent(new Event('mouseup')); // exercises the real window onUp
  });
});
