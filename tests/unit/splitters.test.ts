import { describe, it, expect, vi } from 'vitest';
import { dragValue, startDrag, clampDrawerWidth, clampDockedInspectorWidth, CENTRE_MIN_PX } from '../../src/ui/splitters.js';
import type { DragPoint } from '../../src/ui/splitters.js';

describe('clampDrawerWidth', () => {
  it('clamps to [320, 92% of viewport width]', () => {
    expect(clampDrawerWidth(100, 1000)).toBe(320); // below floor
    expect(clampDrawerWidth(500, 1000)).toBe(500); // within bounds
    expect(clampDrawerWidth(999, 1000)).toBe(920); // above 92vw cap
  });
});

// #586 finding 2a: the dock-aware ceiling protects the centre work surface
// (`.query-host`/`.dashboard-host`) — `clampDrawerWidth`'s flat 92vw bound
// alone can starve it to nothing once the inspector is a real `.main-row`
// sibling instead of a `position: fixed` overlay.
describe('clampDockedInspectorWidth', () => {
  it('CENTRE_MIN_PX matches clampDrawerWidth\'s own 320 floor — both sides of the split share one "usable panel" minimum', () => {
    expect(CENTRE_MIN_PX).toBe(320);
  });
  it('the dock-aware ceiling (totalWidth - reservedPx - CENTRE_MIN_PX) binds when it is tighter than 92vw', () => {
    // 1000 total, 200 reserved (sidebar + handles): ceiling = 1000-200-320 = 480,
    // well under 92vw (920) — the dock-aware bound is the one that bites.
    expect(clampDockedInspectorWidth(999, 1000, 200)).toBe(480);
    expect(clampDockedInspectorWidth(480, 1000, 200)).toBe(480); // exactly at the ceiling
    expect(clampDockedInspectorWidth(300, 1000, 200)).toBe(320); // below the shared floor
  });
  it('falls back to the 92vw ceiling when reservedPx is small enough not to bind', () => {
    // 1000 total, 0 reserved: dock-aware ceiling = 1000-0-320 = 680, tighter
    // than 92vw (920) — still the dock-aware bound wins here too, proving
    // Math.min picks whichever is tighter, not "dock-aware always wins".
    expect(clampDockedInspectorWidth(999, 1000, 0)).toBe(680);
  });
  it('a wide row with heavy reservation still floors at 320 even when the computed ceiling is below it', () => {
    // 500 total, 300 reserved: ceiling = 500-300-320 = -120 — clamp's own
    // floor (320) wins regardless (Math.max(lo, Math.min(hi, v)) with hi<lo
    // collapses to lo), matching `clampDrawerWidth`'s existing guarantee that
    // the inspector itself never renders narrower than 320.
    expect(clampDockedInspectorWidth(1000, 500, 300)).toBe(320);
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
  it('rightInspector maps viewportWidth-clientX to px clamped [320, 92vw] when reservedPx is absent (a non-docked caller, e.g. drawer.ts)', () => {
    const vw = { width: 1000 };
    expect(dragValue('rightInspector', { clientX: 500, clientY: 0 }, vw)).toBe(500); // 1000-500
    expect(dragValue('rightInspector', { clientX: 900, clientY: 0 }, vw)).toBe(320); // 1000-900=100 → floor
    expect(dragValue('rightInspector', { clientX: -100, clientY: 0 }, vw)).toBe(920); // 1000-(-100)=1100 → 92vw cap
  });
  // #586 finding 2a: a docked caller (app-shell.ts) always supplies
  // `reservedPx` — its presence (even 0), not the axis itself, switches
  // `dragValue` onto the dock-aware ceiling instead of the plain 92vw one.
  it('rightInspector uses the dock-aware ceiling instead of 92vw when reservedPx is present', () => {
    const vw = { width: 1000, reservedPx: 200 }; // ceiling = 1000-200-320 = 480
    expect(dragValue('rightInspector', { clientX: 500, clientY: 0 }, vw)).toBe(480); // 1000-500=500 → clamped to 480
    expect(dragValue('rightInspector', { clientX: 900, clientY: 0 }, vw)).toBe(320); // 1000-900=100 → floor
    expect(dragValue('rightInspector', { clientX: 600, clientY: 0 }, vw)).toBe(400); // 1000-600=400, within [320,480] — unclamped
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
  it('rightInspector: updates rightInspectorPx + persists', () => {
    const win = fakeWin();
    const handle = document.createElement('div');
    const state = { rightInspectorPx: 0 };
    const apply = vi.fn();
    const save = vi.fn();
    const ctx = { win, state, apply, save, rectFor: () => ({ width: 1000 }) };
    startDrag({ preventDefault: vi.fn(), currentTarget: handle }, 'rightInspector', ctx);
    win._fire('mousemove', { clientX: 500, clientY: 0 });
    expect(state.rightInspectorPx).toBe(500); // 1000-500
    expect(apply).toHaveBeenCalledWith('rightInspector', 500);
    win._fire('mouseup');
    expect(save).toHaveBeenCalledWith('rightInspectorPx', 500);
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
