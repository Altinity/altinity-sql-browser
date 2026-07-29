import { describe, expect, it } from 'vitest';
import { canWidenPanel, nextPanelPlacement, widenLabel } from '../../src/dashboard/application/panel-widen.js';
import type { DashboardStyle } from '../../src/dashboard/application/dashboard-viewer-session.js';

const step = (style: DashboardStyle, placement: unknown): Record<string, unknown> =>
  nextPanelPlacement({ style, placement });
const label = (style: DashboardStyle, placement: unknown): string => widenLabel({ style, placement });

/** Press the button repeatedly, collecting the spans it walks through. Proves the
 *  cycle CLOSES rather than asserting one press at a time. */
const spanCycle = (style: DashboardStyle, from: unknown, presses: number): number[] => {
  const spans: number[] = [];
  let placement = from;
  for (let i = 0; i < presses; i += 1) {
    placement = step(style, placement);
    spans.push((placement as { span: number }).span);
  }
  return spans;
};

describe('canWidenPanel (#535)', () => {
  it('exposes the step for every multi-column style', () => {
    expect(canWidenPanel('columns-2')).toBe(true);
    expect(canWidenPanel('columns-3')).toBe(true);
    expect(canWidenPanel('grafana-grid')).toBe(true);
  });

  // `report` has one column by definition, and `full` renders every tile at the
  // container width WITHOUT persisting any span (#321) — a widen there would
  // write a width the view cannot show and the next mode switch would reveal.
  it('withholds it from the single-column styles', () => {
    expect(canWidenPanel('report')).toBe(false);
    expect(canWidenPanel('full')).toBe(false);
  });
});

describe('nextPanelPlacement — flow presets (#535)', () => {
  it('adds one column per press and wraps at the preset column count', () => {
    expect(spanCycle('columns-3', { span: 1, height: 'medium' }, 4)).toEqual([2, 3, 1, 2]);
    expect(spanCycle('columns-2', { span: 1, height: 'medium' }, 3)).toEqual([2, 1, 2]);
  });

  // Flow's `height` is a three-value enum the flow renderer never applies as
  // pixels, so widening must carry the authored value through untouched rather
  // than "double" a word.
  it('carries the authored height through untouched', () => {
    expect(step('columns-3', { span: 1, height: 'large' })).toEqual({ span: 2, height: 'large' });
    expect(step('columns-3', { span: 3, height: 'compact' })).toEqual({ span: 1, height: 'compact' });
  });

  // A tile with no stored placement resolves to the flow default (span 1,
  // medium) — the same resolution the renderer itself uses, so the first press
  // agrees with what is on screen.
  it('resolves a missing or invalid placement through the flow default', () => {
    expect(step('columns-2', undefined)).toEqual({ span: 2, height: 'medium' });
    expect(step('columns-2', { span: 'wide' })).toEqual({ span: 2, height: 'medium' });
  });

  // A span authored wider than the ACTIVE preset allows (a 3-span tile rendered
  // under `columns-2`) is already past the wrap point, so the press shrinks.
  it('treats an over-wide authored span as already at the maximum', () => {
    expect(step('columns-2', { span: 3, height: 'medium' })).toEqual({ span: 1, height: 'medium' });
  });
});

describe('nextPanelPlacement — grafana-grid (#535)', () => {
  // 12 columns and 16 height units make "one more column" imperceptible, so both
  // dimensions double (owner decision) and each clamps to its own maximum.
  it('doubles span and height, clamping each independently', () => {
    expect(step('grafana-grid', { span: 3, height: 2 })).toEqual({ span: 6, height: 4 });
    expect(step('grafana-grid', { span: 6, height: 4 })).toEqual({ span: 12, height: 8 });
    // Span clamps below its double (7*2 = 14 > 12) while height still doubles.
    expect(step('grafana-grid', { span: 7, height: 2 })).toEqual({ span: 12, height: 4 });
    // Height clamps (10*2 = 20 > 16) while span still doubles.
    expect(step('grafana-grid', { span: 2, height: 10 })).toEqual({ span: 4, height: 16 });
  });

  // The wrap resets the height too: a one-column tile that kept a doubled height
  // would be a narrow four-row column no press asked for.
  it('wraps a full-width tile back to one column at the default height', () => {
    expect(step('grafana-grid', { span: 12, height: 8 })).toEqual({ span: 1, height: 2 });
    expect(spanCycle('grafana-grid', { span: 6, height: 2 }, 3)).toEqual([12, 1, 2]);
  });

  it('resolves a missing placement through the grid default (span 6)', () => {
    expect(step('grafana-grid', undefined)).toEqual({ span: 12, height: 4 });
  });

  // A legacy string height is canonicalized on read by `resolveGridPlacement`,
  // so a document written before #291's numeric units still doubles correctly.
  it('doubles a legacy string height through its canonical unit count', () => {
    expect(step('grafana-grid', { span: 2, height: 'compact' })).toEqual({ span: 4, height: 2 });
  });
});

describe('widenLabel (#535)', () => {
  // The label names the DESTINATION, because the action reverses at the maximum
  // and the tile's own width is the user's only clue about which press they are on.
  it('names the width the next press produces', () => {
    expect(label('columns-3', { span: 1 })).toBe('Widen to 2 columns');
    expect(label('columns-3', { span: 2 })).toBe('Widen to 3 columns');
    expect(label('grafana-grid', { span: 3, height: 2 })).toBe('Widen to 6 columns');
    // Clamped: 7*2 = 14, capped at the grid's 12.
    expect(label('grafana-grid', { span: 7, height: 2 })).toBe('Widen to 12 columns');
  });

  it('announces the shrink at the maximum', () => {
    expect(label('columns-2', { span: 2 })).toBe('Shrink to 1 column');
    expect(label('columns-3', { span: 3 })).toBe('Shrink to 1 column');
    expect(label('grafana-grid', { span: 12, height: 2 })).toBe('Shrink to 1 column');
  });
});
