import { describe, expect, it } from 'vitest';
import { panelTileActions } from '../../src/dashboard/application/panel-tile-actions.js';
import type {
  PanelTileAction, PanelTileActionKind, PanelTileActionsInput,
} from '../../src/dashboard/application/panel-tile-actions.js';
import type { PanelRemovalRefusal } from '../../src/dashboard/application/dashboard-removal.js';

/** A tile every action is available for: the widest style with room to grow, a
 *  resolvable panel query, and a removal the transform would accept. */
const base: PanelTileActionsInput = {
  title: 'Revenue by day',
  dashboardTitle: 'Sales',
  widenStyle: 'columns-3',
  placement: { span: 1, height: 'medium' },
  kpiBandMember: false,
  queryResolves: true,
  queryless: false,
  removalRefusal: null,
};

const actions = (over: Partial<PanelTileActionsInput> = {}): readonly PanelTileAction[] =>
  panelTileActions({ ...base, ...over });

const row = (kind: PanelTileActionKind, over: Partial<PanelTileActionsInput> = {}): PanelTileAction =>
  actions(over).find((action) => action.kind === kind)!;

describe('panelTileActions — the menu vocabulary (#537 follow-up)', () => {
  it('always returns the same four kinds, in the design order, remove last', () => {
    // The vocabulary is the point: a menu that grows and shrinks with the layout
    // style teaches nothing, so every gate is a `reason`, never an absence.
    expect(actions().map((action) => action.kind))
      .toEqual(['duplicate', 'widen', 'open', 'remove']);
  });

  it('keeps that order and length for the most degenerate tile there is', () => {
    const degenerate = actions({
      widenStyle: null, kpiBandMember: true, queryResolves: false, queryless: true,
      removalRefusal: 'ownership-unproven',
    });
    expect(degenerate.map((action) => action.kind))
      .toEqual(['duplicate', 'widen', 'open', 'remove']);
    // Everything except duplicate is unavailable, and every one of them says why.
    expect(degenerate.filter((action) => action.unavailable !== null).map((action) => action.kind))
      .toEqual(['widen', 'open', 'remove']);
    expect(degenerate.every((action) => action.unavailable === null || action.unavailable.length > 0))
      .toBe(true);
  });

  it('marks exactly one action destructive', () => {
    expect(actions().filter((action) => action.destructive).map((action) => action.kind))
      .toEqual(['remove']);
  });
});

describe('panelTileActions — duplicate', () => {
  it('is always available: its refusals are commit-time outcomes, not preconditions', () => {
    for (const over of [
      {}, { widenStyle: null }, { kpiBandMember: true }, { queryResolves: false },
      { queryless: true }, { removalRefusal: 'tile-missing' as PanelRemovalRefusal },
    ]) {
      expect(row('duplicate', over)).toEqual({
        kind: 'duplicate', label: 'Duplicate panel', unavailable: null, confirm: null, destructive: false,
      });
    }
  });
});

describe('panelTileActions — widen', () => {
  it('names the width the next press produces, per flow preset', () => {
    expect(row('widen', { widenStyle: 'columns-2', placement: { span: 1 } }).label)
      .toBe('Widen to 2 columns');
    expect(row('widen', { widenStyle: 'columns-3', placement: { span: 2 } }).label)
      .toBe('Widen to 3 columns');
  });

  it('names the shrink at the maximum, because the action reverses there', () => {
    expect(row('widen', { widenStyle: 'columns-3', placement: { span: 3 } }).label)
      .toBe('Shrink to 1 column');
    expect(row('widen', { widenStyle: 'grafana-grid', placement: { span: 12, height: 4 } }).label)
      .toBe('Shrink to 1 column');
  });

  it('doubles in the grid, matching the step the press actually takes', () => {
    expect(row('widen', { widenStyle: 'grafana-grid', placement: { span: 3, height: 2 } }).label)
      .toBe('Widen to 6 columns');
  });

  it('is available whenever the style has a width to step', () => {
    for (const widenStyle of ['columns-2', 'columns-3', 'grafana-grid'] as const) {
      expect(row('widen', { widenStyle }).unavailable, widenStyle).toBeNull();
    }
  });

  it('explains a single-column layout rather than hiding the row', () => {
    // `report` and `full` resolve to `widenStyle: null` in the caller, as does
    // flow below the mobile breakpoint — one reason covers all three.
    const widen = row('widen', { widenStyle: null });
    expect(widen.unavailable).toBe('This layout has a single column, so there is no width to change.');
    // With no style there is no destination width to name, so the bare verb.
    expect(widen.label).toBe('Widen');
  });

  it('explains a KPI band member ahead of the style: a band has no width at ANY style', () => {
    const widen = row('widen', { kpiBandMember: true, widenStyle: 'columns-3' });
    expect(widen.unavailable).toBe('A KPI band is one full-width stream, so this panel has no width to change.');
    expect(widen.label).toBe('Widen');
  });

  it('still blames the band, not the style, when both are true', () => {
    expect(row('widen', { kpiBandMember: true, widenStyle: null }).unavailable)
      .toContain('KPI band');
  });

  it('never asks for a confirmation', () => {
    expect(row('widen').confirm).toBeNull();
    expect(row('widen', { widenStyle: null }).confirm).toBeNull();
  });
});

describe('panelTileActions — open in Workbench', () => {
  it('is available for a resolvable query-backed panel', () => {
    expect(row('open')).toEqual({
      kind: 'open', label: 'Open in Workbench and run', unavailable: null, confirm: null, destructive: false,
    });
  });

  it('explains a text panel as a capability, not a fault', () => {
    expect(row('open', { queryless: true }).unavailable).toBe('A text panel has no query to open.');
  });

  it('explains an unresolvable query id', () => {
    expect(row('open', { queryResolves: false }).unavailable)
      .toBe('This panel’s query is not in this workspace.');
  });

  it('prefers the text-panel wording when a text panel is ALSO unresolvable', () => {
    // Both are true for a text tile whose document vanished; "no query to open"
    // is the honest one — the user was never going to open it.
    expect(row('open', { queryless: true, queryResolves: false }).unavailable)
      .toBe('A text panel has no query to open.');
  });
});

describe('panelTileActions — remove', () => {
  it('asks a question naming the panel, the dashboard, and the query copy', () => {
    expect(row('remove').confirm)
      .toBe('Remove panel “Revenue by day” from “Sales”? This also deletes its dedicated query copy.');
  });

  it('is available, unavailable-free and destructive when the transform would accept it', () => {
    expect(row('remove')).toEqual({
      kind: 'remove',
      label: 'Remove tile',
      unavailable: null,
      confirm: 'Remove panel “Revenue by day” from “Sales”? This also deletes its dedicated query copy.',
      destructive: true,
    });
  });

  // Every refusal `removeDashboardPanel` can report gets its own present-tense
  // sentence. A table over the union, so a new arm cannot compile un-phrased.
  const reasons: ReadonlyArray<[PanelRemovalRefusal, string]> = [
    ['dashboard-missing', 'This dashboard is no longer part of the workspace.'],
    ['dashboard-duplicate', 'Two dashboards share this id, so nothing can be removed safely.'],
    ['tile-missing', 'This panel is no longer part of the dashboard.'],
    ['tile-duplicate', 'Two resources share this id, so nothing can be removed safely.'],
    ['tile-retargeted', 'This panel now shows a different query.'],
    ['ownership-unproven', 'This panel’s query is shared, missing, or not a panel query.'],
  ];

  for (const [refusal, sentence] of reasons) {
    it(`explains ${refusal} in the present tense`, () => {
      expect(row('remove', { removalRefusal: refusal }).unavailable).toBe(sentence);
    });
  }

  it('gives every refusal a DISTINCT sentence — a shared one would not explain', () => {
    expect(new Set(reasons.map(([, sentence]) => sentence)).size).toBe(reasons.length);
  });

  it('drops the confirmation when it cannot run: there is nothing to confirm', () => {
    // A confirmation on an unavailable row would be a dialog that refuses at the
    // end of itself, which is the failure the availability check exists to avoid.
    for (const [refusal] of reasons) {
      expect(row('remove', { removalRefusal: refusal }).confirm, refusal).toBeNull();
    }
  });

  it('quotes titles typographically, and survives ones that need it', () => {
    expect(row('remove', { title: 'a "quoted" name', dashboardTitle: '' }).confirm)
      .toBe('Remove panel “a "quoted" name” from “”? This also deletes its dedicated query copy.');
  });
});
