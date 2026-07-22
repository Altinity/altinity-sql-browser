import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseParamType } from '../../src/core/param-type.js';
import { chartScaleTimeToInstant, type DashboardTimeRangeGroup } from '../../src/core/time-range.js';
import { createDashboardChartInteractionController } from '../../src/ui/dashboard-chart-interaction.js';

interface Plugin {
  afterInit(chart: FakeChart): void;
  afterLayout(chart: FakeChart): void;
  afterEvent(chart: FakeChart, args: { event?: { type?: string; x?: number; y?: number }; inChartArea?: boolean }): void;
  afterDatasetsDraw(chart: FakeChart): void;
  beforeDestroy(chart: FakeChart): void;
}

const ctx = () => ({
  save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), measureText: vi.fn((s: string) => ({ width: s.length * 5 })),
  strokeStyle: '', fillStyle: '', lineWidth: 0, font: '', textBaseline: '',
});

type FakeCtx = ReturnType<typeof ctx>;
interface FakeChart {
  canvas: HTMLCanvasElement;
  ctx: FakeCtx;
  width: number;
  height: number;
  chartArea?: { left: number; right: number; top: number; bottom: number };
  scales?: { x?: {
    type?: string; min?: number; max?: number;
    getValueForPixel(pixel: number): unknown; getPixelForValue(value: number): number;
  } };
  options?: { indexAxis?: string };
  draw: ReturnType<typeof vi.fn>;
}

const DT = parseParamType('DateTime');
const group = (key = 'from\u0000to'): DashboardTimeRangeGroup => ({
  key, fromFilterId: 'from', toFilterId: 'to', fromParameter: 'from', toParameter: 'to',
  fromType: DT, toType: DT, tileIds: ['a', 'b'], interactiveChartTileIds: [],
});

function chart(over: Partial<FakeChart> = {}): FakeChart {
  const canvas = document.createElement('canvas');
  canvas.width = 400; canvas.height = 200;
  const captured = new Set<number>();
  Object.defineProperties(canvas, {
    setPointerCapture: { configurable: true, value: vi.fn((id: number) => captured.add(id)) },
    hasPointerCapture: { configurable: true, value: vi.fn((id: number) => captured.has(id)) },
    releasePointerCapture: { configurable: true, value: vi.fn((id: number) => captured.delete(id)) },
  });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON: () => ({}),
  });
  return {
    canvas, ctx: ctx(), width: 400, height: 200,
    chartArea: { left: 20, right: 380, top: 10, bottom: 180 },
    scales: { x: {
      type: 'time', min: 0, max: 1000,
      getValueForPixel: (pixel) => pixel * 2.5,
      getPixelForValue: (value) => value / 2.5,
    } },
    options: {}, draw: vi.fn(), ...over,
  };
}

function host(left = 0): HTMLElement {
  const el = document.createElement('div');
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: left, y: 0, left, top: 0, right: left + 420, bottom: 240,
    width: 420, height: 240, toJSON: () => ({}),
  });
  return el;
}

function pointer(type: string, over: Record<string, unknown> = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 50 });
  for (const [key, value] of Object.entries({
    pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 100, clientY: 50, ...over,
  })) Object.defineProperty(event, key, { value, configurable: true });
  return event;
}

function setup() {
  const controller = createDashboardChartInteractionController({
    document,
    formatLabel: (ms) => `at ${ms}`,
    colors: () => ({
      crosshair: 'blue', selectionFill: 'rgba(0,0,255,.2)', selectionStroke: 'blue',
      labelBackground: 'white', labelText: 'black',
    }),
  });
  return controller;
}

afterEach(() => document.body.replaceChildren());

describe('Dashboard chart interaction controller', () => {
  it('synchronizes the exact hover timestamp, keeps groups separate, and hides out-of-range peer lines', () => {
    const controller = setup();
    const g = group();
    const a = chart(); const b = chart(); const other = chart();
    const hostA = host(-10); const hostB = host(-10); const hostOther = host(-10);
    const pa = controller.pluginFor({ group: g, tileId: 'a', crosshairHost: hostA, xType: 'DateTime', onSelect: vi.fn() }) as Plugin;
    const pb = controller.pluginFor({ group: g, tileId: 'b', crosshairHost: hostB, xType: 'DateTime', onSelect: vi.fn() }) as Plugin;
    const po = controller.pluginFor({ group: group('other'), tileId: 'o', crosshairHost: hostOther, xType: 'DateTime', onSelect: vi.fn() }) as Plugin;
    pa.afterInit(a); pb.afterInit(b); po.afterInit(other);
    expect(g.interactiveChartTileIds).toEqual(['a', 'b']);

    pa.afterEvent(a, { event: { type: 'mousemove', x: 100, y: 50 }, inChartArea: true });
    expect(a.draw).toHaveBeenCalledTimes(1);
    expect(b.draw).toHaveBeenCalledTimes(1);
    expect(other.draw).not.toHaveBeenCalled();
    pb.afterDatasetsDraw(b);
    expect(hostB.classList.contains('is-time-crosshair')).toBe(true);
    expect(hostB.style.getPropertyValue('--dash-time-crosshair-x')).toBe('110px');
    expect(hostB.style.getPropertyValue('--dash-time-crosshair-color')).toBe('blue');
    expect(b.ctx.stroke).not.toHaveBeenCalled();

    // Same value/active chart is deduped; a peer mouseout cannot clear the
    // active chart's hover.
    pa.afterEvent(a, { event: { type: 'mousemove', x: 100, y: 50 }, inChartArea: true });
    pb.afterEvent(b, { event: { type: 'mouseout' }, inChartArea: false });
    pb.afterDatasetsDraw(b);
    expect(a.draw).toHaveBeenCalledTimes(1);
    expect(hostB.classList.contains('is-time-crosshair')).toBe(true);

    b.scales!.x!.max = 200;
    pb.afterDatasetsDraw(b);
    expect(hostB.classList.contains('is-time-crosshair')).toBe(false);
    b.scales!.x!.max = 1000;
    b.scales!.x!.getPixelForValue = () => NaN;
    pb.afterDatasetsDraw(b);
    expect(hostB.classList.contains('is-time-crosshair')).toBe(false);
    pa.afterEvent(a, { event: { type: 'mouseout' }, inChartArea: false });
    expect(a.draw).toHaveBeenCalledTimes(2);
    expect(b.draw).toHaveBeenCalledTimes(2);

    pa.beforeDestroy(a);
    expect(g.interactiveChartTileIds).toEqual(['b']);
    expect(a.canvas.classList.contains('dash-time-chart')).toBe(false);
    expect(hostA.classList.contains('dash-time-crosshair-host')).toBe(false);
    pb.beforeDestroy(b); po.beforeDestroy(other); controller.destroy();
  });

  it('ignores invalid hover events and incompatible charts', () => {
    const controller = setup();
    const g = group();
    const incompatible = chart({ options: { indexAxis: 'y' } });
    const p = controller.pluginFor({ group: g, tileId: 'a', crosshairHost: host(), xType: 'DateTime', onSelect: vi.fn() }) as Plugin;
    p.afterInit(incompatible); p.afterInit(incompatible);
    expect(g.interactiveChartTileIds).toEqual([]);
    incompatible.options = {};
    p.afterLayout(incompatible);
    expect(g.interactiveChartTileIds).toEqual(['a']);
    incompatible.options = { indexAxis: 'y' };
    p.afterEvent(incompatible, { event: { x: 100, y: 50 } });
    p.afterDatasetsDraw(incompatible);
    incompatible.canvas.dispatchEvent(pointer('pointerdown'));
    expect(incompatible.draw).not.toHaveBeenCalled();

    const valid = chart();
    const pv = controller.pluginFor({ group: g, tileId: 'b', crosshairHost: host(), xType: 'DateTime', onSelect: vi.fn() }) as Plugin;
    pv.afterInit(valid);
    pv.afterEvent(valid, {});
    pv.afterEvent(valid, { event: { type: 'mousemove', x: 100, y: 50 }, inChartArea: false });
    pv.afterEvent(valid, { event: { type: 'mousemove', x: NaN, y: 20 } });
    pv.afterEvent(valid, { event: { type: 'mousemove', x: 1, y: 1 } });
    valid.scales!.x!.getValueForPixel = () => null;
    pv.afterEvent(valid, { event: { type: 'mousemove', x: 100, y: 50 }, inChartArea: true });
    valid.scales!.x!.getValueForPixel = () => Number.MAX_VALUE;
    pv.afterEvent(valid, { event: { type: 'mousemove', x: 100, y: 50 }, inChartArea: true });
    valid.canvas.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
    window.dispatchEvent(pointer('pointermove', { clientX: 200 }));
    pv.afterDatasetsDraw(valid);
    window.dispatchEvent(pointer('pointerup', { clientX: 200 }));
    expect(valid.ctx.fillRect).not.toHaveBeenCalled();
    p.beforeDestroy(incompatible); p.beforeDestroy(incompatible);
    pv.beforeDestroy(valid); controller.destroy();
  });

  it('fails closed when a chart column declares an invalid timezone', () => {
    const controller = setup(); const g = group(); const c = chart(); const onSelect = vi.fn();
    const p = controller.pluginFor({
      group: g, tileId: 'a', crosshairHost: host(), xType: "DateTime('Not/A_Zone')", onSelect,
    }) as Plugin;
    p.afterInit(c);
    expect(g.interactiveChartTileIds).toEqual([]);
    p.afterEvent(c, { event: { type: 'mousemove', x: 100, y: 50 }, inChartArea: true });
    c.canvas.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
    window.dispatchEvent(pointer('pointermove', { clientX: 200 }));
    p.afterDatasetsDraw(c);
    window.dispatchEvent(pointer('pointerup', { clientX: 200 }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(c.ctx.fillRect).not.toHaveBeenCalled();
    p.beforeDestroy(c); controller.destroy();
  });

  it('commits a normalized reverse mouse drag only after the movement threshold and paints its band/labels', () => {
    const controller = setup(); const g = group(); const c = chart(); const onSelect = vi.fn();
    const p = controller.pluginFor({ group: g, tileId: 'a', crosshairHost: host(), xType: 'DateTime', onSelect }) as Plugin;
    p.afterInit(c);
    c.canvas.dispatchEvent(pointer('pointerdown', { clientX: 300 }));
    expect(c.canvas.setPointerCapture).toHaveBeenCalledWith(1);
    window.dispatchEvent(pointer('pointermove', { clientX: 250 }));
    p.afterDatasetsDraw(c);
    expect(c.ctx.fillRect).toHaveBeenCalled();
    expect(c.ctx.strokeRect).toHaveBeenCalled();
    expect(c.ctx.fillText).toHaveBeenCalledWith(`at ${chartScaleTimeToInstant(625, 'DateTime')}`, expect.any(Number), 18);
    window.dispatchEvent(pointer('pointerup', { clientX: 100 }));
    expect(c.canvas.releasePointerCapture).toHaveBeenCalledWith(1);
    const selected = [250, 750].map((value) => chartScaleTimeToInstant(value, 'DateTime')!);
    expect(onSelect).toHaveBeenCalledWith(Math.min(...selected), Math.max(...selected));
    expect(c.draw).toHaveBeenCalled();

    c.canvas.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
    window.dispatchEvent(pointer('pointermove', { clientX: 102 }));
    window.dispatchEvent(pointer('pointerup', { clientX: 102 }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    p.beforeDestroy(c); controller.destroy();
  });

  it('delegates modified/touch/non-primary/outside starts and cancels active gestures on every lifecycle signal', () => {
    const controller = setup(); const g = group(); const c = chart(); const onSelect = vi.fn();
    const p = controller.pluginFor({ group: g, tileId: 'a', crosshairHost: host(), xType: 'DateTime', onSelect }) as Plugin;
    p.afterInit(c);
    for (const over of [
      { ctrlKey: true }, { metaKey: true }, { pointerType: 'touch' }, { button: 1 }, { isPrimary: false },
      { clientX: 2 }, { clientY: 195 },
    ]) {
      c.canvas.dispatchEvent(pointer('pointerdown', over));
      window.dispatchEvent(pointer('pointermove', { clientX: 200 }));
      window.dispatchEvent(pointer('pointerup', { clientX: 200 }));
    }
    expect(onSelect).not.toHaveBeenCalled();

    const begin = () => {
      c.canvas.dispatchEvent(pointer('pointerdown'));
      window.dispatchEvent(pointer('pointermove', { clientX: 150 }));
    };
    begin(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A' })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    begin(); window.dispatchEvent(pointer('pointercancel'));
    begin(); window.dispatchEvent(new Event('blur'));
    begin(); c.canvas.dispatchEvent(new Event('lostpointercapture'));
    begin(); p.beforeDestroy(c);
    expect(onSelect).not.toHaveBeenCalled();

    const c2 = chart(); const p2 = controller.pluginFor({ group: g, tileId: 'b', crosshairHost: host(), xType: 'DateTime', onSelect }) as Plugin;
    p2.afterInit(c2);
    c2.canvas.dispatchEvent(pointer('pointerdown'));
    window.dispatchEvent(pointer('pointermove', { clientX: 150 }));
    controller.destroy();
    window.dispatchEvent(pointer('pointerup', { clientX: 200 }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('handles zero-width canvas geometry and absent optional chart fields defensively', () => {
    const controller = setup(); const g = group(); const onSelect = vi.fn();
    const c = chart({ chartArea: undefined, scales: undefined, options: undefined });
    const p = controller.pluginFor({ group: g, tileId: 'a', crosshairHost: host(), xType: 'DateTime', onSelect }) as Plugin;
    p.afterInit(c); p.afterEvent(c, { event: { x: 1, y: 1 } }); p.afterDatasetsDraw(c); p.beforeDestroy(c);

    const z = chart();
    vi.spyOn(z.canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}),
    });
    const pz = controller.pluginFor({ group: g, tileId: 'b', crosshairHost: host(), xType: 'DateTime', onSelect }) as Plugin;
    pz.afterInit(z);
    z.canvas.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 50 }));
    window.dispatchEvent(pointer('pointermove', { clientX: 200, pointerId: 2 }));
    window.dispatchEvent(pointer('pointerup', { clientX: 200, pointerId: 2 }));
    pz.beforeDestroy(z); controller.destroy();
  });

  it('does not install a gesture when the injected document has no window', () => {
    const detached = document.implementation.createHTMLDocument('detached');
    const controller = createDashboardChartInteractionController({
      document: detached, formatLabel: String,
      colors: () => ({ crosshair: '', selectionFill: '', selectionStroke: '', labelBackground: '', labelText: '' }),
    });
    const c = chart(); const onSelect = vi.fn();
    const p = controller.pluginFor({ group: group(), tileId: 'a', crosshairHost: host(), xType: 'DateTime', onSelect }) as Plugin;
    p.afterInit(c); c.canvas.dispatchEvent(pointer('pointerdown'));
    window.dispatchEvent(pointer('pointermove', { clientX: 200 }));
    window.dispatchEvent(pointer('pointerup', { clientX: 200 }));
    expect(onSelect).not.toHaveBeenCalled();
    p.beforeDestroy(c); controller.destroy();
  });
});
