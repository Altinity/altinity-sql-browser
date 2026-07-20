import { describe, it, expect, vi } from 'vitest';
import { dragValue, startDrag, clampDrawerWidth } from '../../src/ui/splitters.js';
import type { DragPoint } from '../../src/ui/splitters.js';

describe('clampDrawerWidth', () => {
  it('clamps to [320, 92% of viewport width]', () => {
    expect(clampDrawerWidth(100, 1000)).toBe(320); // below floor
    expect(clampDrawerWidth(500, 1000)).toBe(500); // within bounds
    expect(clampDrawerWidth(999, 1000)).toBe(920); // above 92vw cap
  });
});

describe('dragValue', () => {
  const rect = { top: 100, bottom: 300 }; // height 200
  it('col clamps clientX to [180,420]', () => {
    expect(dragValue('col', { clientX: 50, clientY: 0 })).toBe(180);
    expect(dragValue('col', { clientX: 250, clientY: 0 })).toBe(250);
    expect(dragValue('col', { clientX: 999, clientY: 0 })).toBe(420);
  });
  it('col follows clientX directly (native coords, no scale argument)', () => {
    expect(dragValue('col', { clientX: 300, clientY: 0 })).toBe(300);
  });
  it('sideRow maps Y to % clamped [25,85]', () => {
    expect(dragValue('sideRow', { clientX: 0, clientY: 200 }, rect)).toBe(50);
    expect(dragValue('sideRow', { clientX: 0, clientY: 100 }, rect)).toBe(25); // 0% → clamp 25
    expect(dragValue('sideRow', { clientX: 0, clientY: 300 }, rect)).toBe(85); // 100% → clamp 85
  });
  it('row maps Y to % clamped [15,85]', () => {
    expect(dragValue('row', { clientX: 0, clientY: 100 }, rect)).toBe(15);
    expect(dragValue('row', { clientX: 0, clientY: 200 }, rect)).toBe(50);
  });
  it('drawer maps viewportWidth-clientX to px clamped [320, 92vw]', () => {
    const vw = { width: 1000 };
    expect(dragValue('drawer', { clientX: 500, clientY: 0 }, vw)).toBe(500); // 1000-500
    expect(dragValue('drawer', { clientX: 900, clientY: 0 }, vw)).toBe(320); // 1000-900=100 → floor
    expect(dragValue('drawer', { clientX: -100, clientY: 0 }, vw)).toBe(920); // 1000-(-100)=1100 → 92vw cap
  });
  it('docPane maps viewportWidth-clientX to px clamped [320, 92vw] — same geometry as drawer (#313)', () => {
    const vw = { width: 1000 };
    expect(dragValue('docPane', { clientX: 500, clientY: 0 }, vw)).toBe(500);
    expect(dragValue('docPane', { clientX: 900, clientY: 0 }, vw)).toBe(320);
    expect(dragValue('docPane', { clientX: -100, clientY: 0 }, vw)).toBe(920);
  });
});

function fakeWin() {
  const handlers: Record<string, (ev: DragPoint) => void> = {};
  return {
    addEventListener: (t: string, fn: (ev: DragPoint) => void) => { handlers[t] = fn; },
    removeEventListener: vi.fn((t: string) => { delete handlers[t]; }),
    _fire: (t: string, ev: DragPoint = { clientX: 0, clientY: 0 }) => { handlers[t]?.(ev); },
    _has: (t: string) => !!handlers[t],
  };
}

describe('startDrag', () => {
  function harness(axis: 'col' | 'sideRow' | 'row') {
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
    win._fire('mousemove', { clientX: 300, clientY: 0 });
    expect(state.sidebarPx).toBe(300);
    expect(apply).toHaveBeenCalledWith('col', 300);
    win._fire('mouseup');
    expect(handle.classList.contains('dragging')).toBe(false);
    expect(save).toHaveBeenCalledWith('sidebarPx', 300);
    expect(win._has('mousemove')).toBe(false);
  });
  it('col: startDrag no longer reads ctx.scale — a stray scale is ignored, width follows clientX natively', () => {
    const win = fakeWin();
    const handle = document.createElement('div');
    const state = { sidebarPx: 0 };
    const apply = vi.fn();
    const ctx = { win, state, apply, save: vi.fn(), rectFor: () => ({}), scale: () => 1.2 };
    startDrag({ preventDefault: vi.fn(), currentTarget: handle }, 'col', ctx);
    win._fire('mousemove', { clientX: 360, clientY: 0 });
    expect(state.sidebarPx).toBe(360); // native clientX, ctx.scale ignored
    expect(apply).toHaveBeenCalledWith('col', 360);
  });
  it('sideRow: updates sideSplitPct + persists', () => {
    const { win, state, save } = harness('sideRow');
    win._fire('mousemove', { clientX: 0, clientY: 50 });
    expect(state.sideSplitPct).toBe(50);
    win._fire('mouseup');
    expect(save).toHaveBeenCalledWith('sideSplitPct', 50);
  });
  it('row: updates editorPct + persists', () => {
    const { win, state, save } = harness('row');
    win._fire('mousemove', { clientX: 0, clientY: 50 });
    expect(state.editorPct).toBe(50);
    win._fire('mouseup');
    expect(save).toHaveBeenCalledWith('editorPct', 50);
  });
  it('drawer: updates cellDrawerPx + persists', () => {
    const win = fakeWin();
    const handle = document.createElement('div');
    const state = { cellDrawerPx: 0 };
    const apply = vi.fn();
    const save = vi.fn();
    const ctx = { win, state, apply, save, rectFor: () => ({ width: 1000 }) };
    startDrag({ preventDefault: vi.fn(), currentTarget: handle }, 'drawer', ctx);
    win._fire('mousemove', { clientX: 500, clientY: 0 });
    expect(state.cellDrawerPx).toBe(500); // 1000-500
    expect(apply).toHaveBeenCalledWith('drawer', 500);
    win._fire('mouseup');
    expect(save).toHaveBeenCalledWith('cellDrawerPx', 500);
  });
  it('docPane: updates docPanePx + persists, independent of cellDrawerPx (#313)', () => {
    const win = fakeWin();
    const handle = document.createElement('div');
    const state = { cellDrawerPx: 777, docPanePx: 0 };
    const apply = vi.fn();
    const save = vi.fn();
    const ctx = { win, state, apply, save, rectFor: () => ({ width: 1000 }) };
    startDrag({ preventDefault: vi.fn(), currentTarget: handle }, 'docPane', ctx);
    win._fire('mousemove', { clientX: 500, clientY: 0 });
    expect(state.docPanePx).toBe(500); // 1000-500
    expect(state.cellDrawerPx).toBe(777); // untouched
    expect(apply).toHaveBeenCalledWith('docPane', 500);
    win._fire('mouseup');
    expect(save).toHaveBeenCalledWith('docPanePx', 500);
    expect(save).not.toHaveBeenCalledWith('cellDrawerPx', expect.anything());
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
