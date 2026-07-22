import {
  chartScaleTimeToInstant,
  instantToChartScaleTime,
  type DashboardTimeRangeGroup,
} from '../core/time-range.js';
import type { ParsedParamType } from '../core/param-type.js';
import { movedPastThreshold } from '../core/tile-reorder.js';

interface TimeScale {
  type?: string;
  min?: number;
  max?: number;
  getValueForPixel(pixel: number): unknown;
  getPixelForValue(value: number): number;
}

interface InteractiveChart {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  chartArea?: { left: number; right: number; top: number; bottom: number };
  scales?: { x?: TimeScale };
  options?: { indexAxis?: string };
  draw(): void;
}

export interface DashboardChartRegistration {
  group: DashboardTimeRangeGroup;
  tileId: string;
  /** Declared type of the chart's horizontal time column. */
  xType: ParsedParamType | string;
  onSelect(fromMs: number, toMs: number): void;
}

export interface DashboardChartInteractionController {
  pluginFor(registration: DashboardChartRegistration): unknown;
  destroy(): void;
}

interface InteractionColors {
  crosshair: string;
  selectionFill: string;
  selectionStroke: string;
  labelBackground: string;
  labelText: string;
}

interface RecordEntry { chart: InteractiveChart; registration: DashboardChartRegistration; onPointerDown: EventListener }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function createDashboardChartInteractionController(opts: {
  document: Document;
  formatLabel(ms: number, type: ParsedParamType): string;
  colors(): InteractionColors;
}): DashboardChartInteractionController {
  const records = new Map<InteractiveChart, RecordEntry>();
  const hoverByGroup = new Map<string, { timestamp: number; active: InteractiveChart }>();
  let selection: {
    chart: InteractiveChart;
    registration: DashboardChartRegistration;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    currentX: number;
    active: boolean;
    cleanup(): void;
  } | null = null;

  const compatible = (chart: InteractiveChart): chart is InteractiveChart & {
    chartArea: NonNullable<InteractiveChart['chartArea']>; scales: { x: TimeScale };
  } => chart.options?.indexAxis !== 'y' && chart.scales?.x?.type === 'time' && !!chart.chartArea;
  const eligible = (chart: InteractiveChart, registration: DashboardChartRegistration): chart is InteractiveChart & {
    chartArea: NonNullable<InteractiveChart['chartArea']>; scales: { x: TimeScale };
  } => compatible(chart) && instantToChartScaleTime(0, registration.xType) != null;

  const redrawGroup = (key: string): void => {
    for (const entry of records.values()) if (entry.registration.group.key === key) entry.chart.draw();
  };

  const clearHover = (key: string, chart?: InteractiveChart): void => {
    const current = hoverByGroup.get(key);
    if (!current || (chart && current.active !== chart)) return;
    hoverByGroup.delete(key);
    redrawGroup(key);
  };

  const chartX = (chart: InteractiveChart, clientX: number): number => {
    const rect = chart.canvas.getBoundingClientRect();
    return rect.width > 0 ? ((clientX - rect.left) / rect.width) * chart.width : clientX - rect.left;
  };

  const clampedX = (chart: InteractiveChart & { chartArea: NonNullable<InteractiveChart['chartArea']> }, x: number): number =>
    Math.max(chart.chartArea.left, Math.min(chart.chartArea.right, x));

  const beginSelection = (chart: InteractiveChart, registration: DashboardChartRegistration, pe: PointerEvent): void => {
    if (!eligible(chart, registration) || pe.pointerType !== 'mouse' || pe.button !== 0 || pe.isPrimary === false || pe.metaKey || pe.ctrlKey) return;
    const x = chartX(chart, pe.clientX);
    const rect = chart.canvas.getBoundingClientRect();
    const y = rect.height > 0 ? ((pe.clientY - rect.top) / rect.height) * chart.height : pe.clientY - rect.top;
    if (x < chart.chartArea.left || x > chart.chartArea.right || y < chart.chartArea.top || y > chart.chartArea.bottom) return;
    selection?.cleanup();
    const win = opts.document.defaultView;
    if (!win) return;
    const onMove = (event: PointerEvent): void => {
      if (!selection || event.pointerId !== selection.pointerId) return;
      selection.currentX = clampedX(chart, chartX(chart, event.clientX));
      if (!selection.active && movedPastThreshold(
        event.clientX - selection.startClientX, event.clientY - selection.startClientY,
      )) selection.active = true;
      if (selection.active) { event.preventDefault(); chart.draw(); }
    };
    const finish = (event: PointerEvent): void => {
      if (!selection || event.pointerId !== selection.pointerId) return;
      const current = selection;
      const active = current.active;
      current.currentX = clampedX(chart, chartX(chart, event.clientX));
      const scale = chart.scales.x;
      const a = scale.getValueForPixel(current.startX);
      const b = scale.getValueForPixel(current.currentX);
      current.cleanup();
      const instantA = finite(a) ? chartScaleTimeToInstant(a, registration.xType) : null;
      const instantB = finite(b) ? chartScaleTimeToInstant(b, registration.xType) : null;
      if (active && instantA != null && instantB != null) {
        registration.onSelect(Math.min(instantA, instantB), Math.max(instantA, instantB));
      }
    };
    const cancel = (): void => selection?.cleanup();
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') cancel(); };
    const cleanup = (): void => {
      win.removeEventListener('pointermove', onMove as EventListener);
      win.removeEventListener('pointerup', finish as EventListener);
      win.removeEventListener('pointercancel', cancel);
      win.removeEventListener('blur', cancel);
      opts.document.removeEventListener('keydown', onKey, true);
      chart.canvas.removeEventListener('lostpointercapture', cancel);
      if (selection?.chart === chart) selection = null;
      chart.draw();
    };
    selection = {
      chart, registration, pointerId: pe.pointerId, startClientX: pe.clientX, startClientY: pe.clientY,
      startX: x, currentX: x, active: false, cleanup,
    };
    win.addEventListener('pointermove', onMove as EventListener);
    win.addEventListener('pointerup', finish as EventListener);
    win.addEventListener('pointercancel', cancel);
    win.addEventListener('blur', cancel);
    opts.document.addEventListener('keydown', onKey, true);
    chart.canvas.addEventListener('lostpointercapture', cancel);
  };

  const draw = (chart: InteractiveChart, registration: DashboardChartRegistration): void => {
    if (!eligible(chart, registration)) return;
    const { ctx, chartArea } = chart;
    const colors = opts.colors();
    const hover = hoverByGroup.get(registration.group.key);
    ctx.save();
    if (hover) {
      const scale = chart.scales.x;
      const scaleTimestamp = instantToChartScaleTime(hover.timestamp, registration.xType);
      if (scaleTimestamp != null
        && (!finite(scale.min) || scaleTimestamp >= scale.min)
        && (!finite(scale.max) || scaleTimestamp <= scale.max)) {
        const x = scale.getPixelForValue(scaleTimestamp);
        if (finite(x) && x >= chartArea.left && x <= chartArea.right) {
          ctx.strokeStyle = colors.crosshair;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        }
      }
    }
    if (selection?.chart === chart && selection.active) {
      const left = Math.min(selection.startX, selection.currentX);
      const right = Math.max(selection.startX, selection.currentX);
      const from = chart.scales.x.getValueForPixel(left);
      const to = chart.scales.x.getValueForPixel(right);
      if (finite(from) && finite(to)) {
        const fromInstant = chartScaleTimeToInstant(from, registration.xType);
        const toInstant = chartScaleTimeToInstant(to, registration.xType);
        if (fromInstant == null || toInstant == null) { ctx.restore(); return; }
        ctx.fillStyle = colors.selectionFill;
        ctx.strokeStyle = colors.selectionStroke;
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
        ctx.strokeRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
        const labels = [
          opts.formatLabel(fromInstant, registration.group.fromType),
          opts.formatLabel(toInstant, registration.group.toType),
        ];
        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'top';
        const widths = labels.map((label) => ctx.measureText(label).width + 10);
        const clampLabel = (center: number, width: number): number =>
          Math.max(chartArea.left, Math.min(chartArea.right - width, center - width / 2));
        const xs = [clampLabel(left, widths[0]), clampLabel(right, widths[1])];
        labels.forEach((label, index) => {
          ctx.fillStyle = colors.labelBackground; ctx.fillRect(xs[index], chartArea.top + 4, widths[index], 20);
          ctx.fillStyle = colors.labelText; ctx.fillText(label, xs[index] + 5, chartArea.top + 8);
        });
      }
    }
    ctx.restore();
  };

  const syncCompatibility = (chart: InteractiveChart, registration: DashboardChartRegistration): void => {
    if (!eligible(chart, registration)) return;
    chart.canvas.classList.add('dash-time-chart');
    if (!registration.group.interactiveChartTileIds.includes(registration.tileId)) {
      registration.group.interactiveChartTileIds.push(registration.tileId);
    }
  };

  const pluginFor = (registration: DashboardChartRegistration): unknown => ({
    id: `asb-dashboard-time-range-${registration.tileId}`,
    afterInit(chart: InteractiveChart) {
      const onPointerDown = ((event: PointerEvent) => beginSelection(chart, registration, event)) as EventListener;
      chart.canvas.addEventListener('pointerdown', onPointerDown);
      records.set(chart, { chart, registration, onPointerDown });
      syncCompatibility(chart, registration);
    },
    afterLayout(chart: InteractiveChart) {
      // Real Chart.js constructs scales after `afterInit`; keep membership in
      // sync once layout has materialized the actual horizontal scale.
      syncCompatibility(chart, registration);
    },
    afterEvent(chart: InteractiveChart, args: { event?: { type?: string; x?: number; y?: number }; inChartArea?: boolean }) {
      if (!eligible(chart, registration)) return;
      const event = args.event;
      if (event?.type !== 'mousemove' && event?.type !== 'pointermove') {
        clearHover(registration.group.key, chart); return;
      }
      if (args.inChartArea === false || !finite(event.x) || !finite(event.y)
        || event.x < chart.chartArea.left || event.x > chart.chartArea.right
        || event.y < chart.chartArea.top || event.y > chart.chartArea.bottom) {
        clearHover(registration.group.key, chart); return;
      }
      const timestamp = chart.scales.x.getValueForPixel(event.x);
      if (!finite(timestamp)) { clearHover(registration.group.key, chart); return; }
      const instant = chartScaleTimeToInstant(timestamp, registration.xType);
      if (instant == null) { clearHover(registration.group.key, chart); return; }
      const current = hoverByGroup.get(registration.group.key);
      if (current?.timestamp === instant && current.active === chart) return;
      hoverByGroup.set(registration.group.key, { timestamp: instant, active: chart });
      redrawGroup(registration.group.key);
    },
    afterDatasetsDraw(chart: InteractiveChart) { draw(chart, registration); },
    beforeDestroy(chart: InteractiveChart) {
      if (selection?.chart === chart) selection.cleanup();
      const entry = records.get(chart);
      if (entry) chart.canvas.removeEventListener('pointerdown', entry.onPointerDown);
      chart.canvas.classList.remove('dash-time-chart');
      const interactiveIndex = registration.group.interactiveChartTileIds.indexOf(registration.tileId);
      if (interactiveIndex >= 0) registration.group.interactiveChartTileIds.splice(interactiveIndex, 1);
      records.delete(chart);
      clearHover(registration.group.key, chart);
    },
  });

  return {
    pluginFor,
    destroy(): void {
      selection?.cleanup();
      for (const entry of records.values()) entry.chart.canvas.removeEventListener('pointerdown', entry.onPointerDown);
      records.clear(); hoverByGroup.clear();
    },
  };
}
