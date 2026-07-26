import { describe, it, expect, vi } from 'vitest';
import { analyzeParameterizedSources, fieldControls } from '../../src/core/param-pipeline.js';
import type { FieldControl, PreparedFieldState } from '../../src/core/param-pipeline.js';
import { buildFilterBar, FILTER_DEBOUNCE_MS } from '../../src/ui/filter-bar.js';
import { emptyRecentMap, recordRecent } from '../../src/core/recent-values.js';
import { parseParamType } from '../../src/core/param-type.js';
import type { DashboardTimeRangeGroup, TimeRangeRecent } from '../../src/core/time-range.js';
import { makeApp } from '../helpers/fake-app.js';

// #447 rewrote this spec: `buildFilterBar` has ONE field branch left. The
// curated branch (a Dashboard filter drawing its options from a saved
// "Filter"-role query — the strict single-select combobox, the multiselect
// dialog, and the per-field source-status affordance) went with the option-
// provider model, so every field the bar builds is now a PLAIN direct input.
// These tests cover that surviving surface end to end: the field-family
// construction, the debounce/Enter/blur commit semantics, the shared
// invalid/conflict affordances, the #345 widths, the #335 compound time-range
// section, and the extraction's own seams (injected document realm, the #185
// accessible-group label, and the #276 Phase 3b dispose seam).
const paramsFor = (sql: string): FieldControl[] =>
  fieldControls(analyzeParameterizedSources([{ id: 't', kind: 'tab', sql, bindPolicy: 'row-returning' }]));
const okField = (): PreparedFieldState => ({ state: 'ok' });

describe('buildFilterBar (shared filter row)', () => {
  it('is a labeled group and builds a field per param when ariaLabel + document are given', () => {
    const app = makeApp();
    const bar = buildFilterBar(
      app,
      paramsFor('SELECT * FROM t WHERE x = {x:String}'),
      () => {},
      okField,
      { document, ariaLabel: 'Query filters' },
    );
    expect(bar.el.getAttribute('role')).toBe('group');
    expect(bar.el.getAttribute('aria-label')).toBe('Query filters');
    expect(bar.el.querySelectorAll('.var-field').length).toBe(1);
    expect(bar.el.style.display).not.toBe('none');
  });

  it('renders a hidden-but-labeled empty bar when there are no params', () => {
    const app = makeApp();
    const bar = buildFilterBar(app, [], () => {}, okField, { ariaLabel: 'Query filters' });
    expect(bar.el.style.display).toBe('none');
    expect(bar.el.getAttribute('aria-label')).toBe('Query filters');
    expect(bar.el.querySelectorAll('.var-field').length).toBe(0);
    expect(() => bar.dispose()).not.toThrow(); // no fields, no timers — a no-op
    expect(() => bar.updateStatus({})).not.toThrow(); // nothing built — a no-op
    expect(bar.openPopoverKey()).toBeNull(); // no popover-bearing controls at all — always null
    expect(bar.focusedFieldKey()).toBeNull();
    expect(() => bar.focusFieldTrigger('x')).not.toThrow(); // unknown param — a no-op
    expect(bar.fieldElement('x')).toBeNull(); // #425: nothing built, nothing to navigate to
    expect(() => bar.refreshTimeRangeLabels(Date.now())).not.toThrow();
  });

  it('defaults to app.document and no group role when no options are passed', () => {
    const app = makeApp();
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField);
    expect(bar.el.getAttribute('role')).toBeNull();
    expect(bar.el.getAttribute('aria-label')).toBeNull();
    expect(bar.el.querySelectorAll('.var-field').length).toBe(1);
  });

  it('marks a plain optional parameter as optional', () => {
    const bar = buildFilterBar(
      makeApp(), paramsFor('SELECT 1 /*[ WHERE x = {x:String} ]*/'), () => {}, okField,
    );
    expect(bar.el.querySelector('.var-field')!.classList.contains('is-optional')).toBe(true);
  });

  it('a blur before any edit is a no-op commit', () => {
    const onCommit = vi.fn();
    const bar = buildFilterBar(makeApp(), paramsFor('SELECT {x:String}'), onCommit, okField);
    bar.el.querySelector('input')!.dispatchEvent(new Event('blur'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('typing persists the value + activation and commits once the debounce elapses', () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      const onCommit = vi.fn();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), onCommit, okField);
      const input = bar.el.querySelector('input')! as HTMLInputElement;
      input.value = 'abc';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Persisted synchronously (#165: a text control syncs activation with the
      // value), committed only after the shared debounce.
      expect(app.state.varValues.x).toBe('abc');
      expect(app.state.filterActive.x).toBe(true);
      expect(app.params.saveVarValues).toHaveBeenCalled();
      expect(app.params.saveFilterActive).toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
      expect(onCommit).toHaveBeenCalledWith('x');
      // Clearing the field deactivates it again.
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(app.state.filterActive.x).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a blur AFTER an edit commits immediately, consuming the pending debounce exactly once', () => {
    vi.useFakeTimers();
    try {
      const onCommit = vi.fn();
      const bar = buildFilterBar(makeApp(), paramsFor('SELECT {x:String}'), onCommit, okField);
      const input = bar.el.querySelector('input')! as HTMLInputElement;
      input.value = 'abc';
      input.dispatchEvent(new Event('input', { bubbles: true })); // arms the debounce
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      expect(onCommit).toHaveBeenCalledTimes(1);
      // The armed timer was cleared by the hard commit — it must not fire again.
      vi.advanceTimersByTime(FILTER_DEBOUNCE_MS + 10);
      expect(onCommit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes the shared debounce constant', () => {
    expect(FILTER_DEBOUNCE_MS).toBe(500);
  });

  it('a recent-value pick commits immediately and Clear recent clears the field recents (#171)', () => {
    const app = makeApp();
    app.state.varRecent = recordRecent(emptyRecentMap(), 'x', 'foo');
    const onCommit = vi.fn();
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), onCommit, okField, { document });
    document.body.appendChild(bar.el);
    const input = bar.el.querySelector('input')!;
    input.dispatchEvent(new Event('focus'));
    input.value = 'f';
    input.dispatchEvent(new Event('input', { bubbles: true })); // arm debounce; pick clears it
    const opt = bar.el.querySelector('[role="option"]');
    expect(opt).not.toBeNull();
    opt!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(onCommit).toHaveBeenCalledWith('x'); // onPick — immediate commit
    input.dispatchEvent(new Event('focus'));
    bar.el.querySelector('.var-combo-footer button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(app.params.clearVarRecent).toHaveBeenCalledWith('x'); // onClearRecent
    bar.el.remove();
  });

  it('a preset pick with no pending debounce still commits (the un-armed onPick path)', () => {
    const app = makeApp();
    app.state.varRecent = recordRecent(emptyRecentMap(), 'x', 'foo');
    const onCommit = vi.fn();
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), onCommit, okField, { document });
    document.body.appendChild(bar.el);
    const input = bar.el.querySelector('input')!;
    input.dispatchEvent(new Event('focus')); // opens the list without typing — no timer armed
    bar.el.querySelector('[role="option"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(onCommit).toHaveBeenCalledWith('x');
    bar.el.remove();
  });

  it('reports no focused field when the document has no active element', () => {
    const bar = buildFilterBar(makeApp(), paramsFor('SELECT {x:String}'), () => {}, okField, { document });
    const descriptor = Object.getOwnPropertyDescriptor(document, 'activeElement');
    Object.defineProperty(document, 'activeElement', { configurable: true, value: null });
    try {
      expect(bar.focusedFieldKey()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(document, 'activeElement', descriptor);
      else Reflect.deleteProperty(document, 'activeElement');
    }
  });

  it('marks a field is-conflict when its declared type disagrees across sources (#173)', () => {
    const params = fieldControls(analyzeParameterizedSources([
      { id: 'A', kind: 'tab', sql: 'SELECT {x:UInt64}', bindPolicy: 'row-returning' },
      { id: 'B', kind: 'tab', sql: 'SELECT {x:String}', bindPolicy: 'row-returning' },
    ]));
    const bar = buildFilterBar(makeApp(), params, () => {}, okField);
    const input = bar.el.querySelector('input')!;
    expect(input.classList.contains('is-conflict')).toBe(true);
    expect(input.title).toContain('Conflicting type declarations: UInt64 vs String');
  });

  it('applies the shared is-invalid affordance from the prepared batch (#170)', () => {
    const invalidField = (): PreparedFieldState => ({ state: 'invalid', reason: 'Bad value' });
    const bar = buildFilterBar(makeApp(), paramsFor('SELECT {x:String}'), () => {}, invalidField);
    const input = bar.el.querySelector('input')! as HTMLInputElement;
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.title).toBe('Bad value');
  });

  it('an optional parameter names the blank-leaves-it-out contract in its tooltip', () => {
    const bar = buildFilterBar(
      makeApp(), paramsFor('SELECT 1 /*[ WHERE x = {x:String} ]*/'), () => {}, okField,
    );
    const input = bar.el.querySelector('input')! as HTMLInputElement;
    expect(input.title).toBe('x: String — optional: blank leaves its filter block out');
  });

  // #345: compact, type-aware field widths — one stable ch width per field,
  // resolved from the declared type (or 'enum' for a declared-Enum dropdown).
  describe('field width (#345)', () => {
    it('a plain text field (String) gets the generic string width', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {name:String}'), () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('16');
    });
    it('a tiny-integer field (UInt8) gets the bool/tiny-int width', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {flag:UInt8}'), () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('9');
    });
    it('a Date field is narrower than a DateTime field, even though both render the date-like combobox', () => {
      const app = makeApp();
      const dateBar = buildFilterBar(app, paramsFor('SELECT {d:Date}'), () => {}, okField);
      const dtBar = buildFilterBar(app, paramsFor('SELECT {dt:DateTime}'), () => {}, okField);
      expect(dateBar.el.querySelector<HTMLInputElement>('.var-input')!.style.getPropertyValue('--var-input-ch')).toBe('13');
      expect(dtBar.el.querySelector<HTMLInputElement>('.var-input')!.style.getPropertyValue('--var-input-ch')).toBe('17');
    });
    it("a declared Enum8 field gets the enum width", () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor("SELECT {kind:Enum8('a' = 1, 'b' = 2)}"), () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('14');
    });
    it('a type-conflicted field still gets a width, from its first bound declaration\'s type', () => {
      const app = makeApp();
      const params = fieldControls(analyzeParameterizedSources([
        { id: 'A', kind: 'tab', sql: 'SELECT {x:UInt64}', bindPolicy: 'row-returning' },
        { id: 'B', kind: 'tab', sql: 'SELECT {x:String}', bindPolicy: 'row-returning' },
      ]));
      const bar = buildFilterBar(app, params, () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('13'); // UInt64 (first declaration) → numeric
    });
    it('never changes while typing — set once at field build, not on every keystroke', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {name:String}'), () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      const before = input.style.getPropertyValue('--var-input-ch');
      input.value = 'a much longer value than the field is wide';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(input.style.getPropertyValue('--var-input-ch')).toBe(before);
    });
  });

  // #335: the compound time-range control section + the handle-map
  // unification's seams. `buildTimeRangeField`'s own behavior (popover columns,
  // staged editing, validation) is covered exhaustively by
  // time-range-field.test.ts — these exercise buildFilterBar's INTEGRATION of
  // it: the "Time" section ahead of the fields, pair suppression, the unified
  // key-space (`group:…`), and `refreshTimeRangeLabels` delegation.
  describe('time-range section + unified handle map (#335)', () => {
    const dt = parseParamType('DateTime');
    // The group key's own separator is a NUL (core/time-range.ts) — written as an
    // escape here so this file stays plain text.
    const GROUP_KEY = 'from\u0000to';
    const dtGroup = (): DashboardTimeRangeGroup => ({
      key: GROUP_KEY, fromFilterId: 'from', toFilterId: 'to',
      fromParameter: 'from', toParameter: 'to', fromType: dt, toType: dt,
      tileIds: [], interactiveChartTileIds: [],
    });
    const trEntry = (over: Partial<{
      fromValue: string; toValue: string; active: boolean; waveNowMs: number | null;
      recents: () => readonly TimeRangeRecent[];
    }> = {}) => ({
      group: dtGroup(), fromValue: '', toValue: '', active: false, waveNowMs: 0 as number | null,
      recents: (): readonly TimeRangeRecent[] => [], ...over,
    });
    // from/to (grouped) + region (plain) — the group owns from/to.
    const groupParams = paramsFor('SELECT k FROM t WHERE d >= {from:DateTime} AND d < {to:DateTime} AND r = {region:String}');

    it('renders a "Time" section (label + control + separator) AHEAD of the fields, suppresses the pair, and labels the rest "Filters"', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, groupParams, () => {}, okField, { timeRange: [trEntry()] });
      expect(bar.el.contains(bar.timeEl)).toBe(true);
      expect(bar.el.contains(bar.ordinaryEl)).toBe(true);
      expect([...bar.el.querySelectorAll('.flabel')].map((n) => n.textContent)).toEqual(['Time', 'Filters']);
      // The combined form retains its section separator.
      expect(bar.el.querySelectorAll('.var-field.is-time-range').length).toBe(1);
      expect(bar.el.querySelector('.trf-trigger')).not.toBeNull();
      expect(bar.el.querySelectorAll('.trf-sep').length).toBe(1);
      // The pair's own two individual fields are gone; only the non-group field remains.
      const names = [...bar.ordinaryEl.querySelectorAll('.var-field:not(.is-time-range) .var-name')].map((n) => n.textContent);
      expect(names).toEqual(['region']);
      // #425: navigation resolves a field by its stamped key, searched from the
      // two separately-mountable regions (a caller re-parents them, emptying
      // `el`). A parameter the time-range group OWNS has no standalone field, so
      // it resolves to that compound control — not to nothing.
      expect(bar.fieldElement('region')!.querySelector('.var-name')!.textContent).toBe('region');
      const compound = bar.fieldElement('from');
      expect(compound!.classList.contains('is-time-range')).toBe(true);
      expect(bar.fieldElement('to')).toBe(compound);
      expect(bar.fieldElement('nope')).toBeNull();
      expect([...bar.el.children]).toEqual([bar.timeEl, bar.ordinaryEl]);
    });

    it('omits the "Filters" label when every remaining param is grouped (no non-group field left)', () => {
      const app = makeApp();
      const params = paramsFor('SELECT k FROM t WHERE d >= {from:DateTime} AND d < {to:DateTime}');
      const bar = buildFilterBar(app, params, () => {}, okField, { timeRange: [trEntry()] });
      expect([...bar.el.querySelectorAll('.flabel')].map((n) => n.textContent)).toEqual(['Time']);
      expect(bar.el.querySelector('.var-field:not(.is-time-range)')).toBeNull();
    });

    it('renders no time section (no flabel/trf-sep) when timeRange is absent or empty — the plain path', () => {
      const app = makeApp();
      const absent = buildFilterBar(app, groupParams, () => {}, okField);
      expect(absent.el.querySelector('.flabel')).toBeNull();
      expect(absent.el.querySelector('.trf-sep')).toBeNull();
      expect(absent.el.querySelector('.trf-trigger')).toBeNull();
      // All three params render as ordinary fields (nothing suppressed).
      expect([...absent.el.querySelectorAll('.var-name')].map((n) => n.textContent)).toEqual(['from', 'to', 'region']);
      const empty = buildFilterBar(app, groupParams, () => {}, okField, { timeRange: [] });
      expect(empty.el.querySelector('.flabel')).toBeNull();
    });

    it('openPopoverKey()/focusFieldTrigger() speak the group key-space; dispose() cancels an open time-range popover', () => {
      const app = makeApp();
      const onApplyTimeRange = vi.fn();
      const bar = buildFilterBar(app, groupParams, () => {}, okField, { timeRange: [trEntry()], onApplyTimeRange });
      document.body.appendChild(bar.el);
      const key = `group:${GROUP_KEY}`;
      expect(bar.openPopoverKey()).toBeNull();
      const trigger = bar.el.querySelector('.trf-trigger') as HTMLButtonElement;
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.body.querySelector('.trf-popover')).not.toBeNull();
      expect(bar.openPopoverKey()).toBe(key);
      // The same key-space answers focusedFieldKey() while the trigger holds focus.
      trigger.focus();
      expect(bar.focusedFieldKey()).toBe(key);
      // focusFieldTrigger addresses the same key-space.
      bar.focusFieldTrigger(key);
      expect(document.activeElement).toBe(trigger);
      // dispose while open is a silent Cancel: no onApply, popover gone.
      bar.dispose();
      expect(document.body.querySelector('.trf-popover')).toBeNull();
      expect(onApplyTimeRange).not.toHaveBeenCalled();
      bar.el.remove();
    });

    it('an Apply routes through onApplyTimeRange with the group + trimmed bounds', () => {
      const app = makeApp();
      const onApplyTimeRange = vi.fn();
      const bar = buildFilterBar(app, groupParams, () => {}, okField, { timeRange: [trEntry()], onApplyTimeRange });
      document.body.appendChild(bar.el);
      (bar.el.querySelector('.trf-trigger') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const inputs = [...document.body.querySelectorAll('.trf-input')] as HTMLInputElement[];
      inputs[0].value = '-1d'; inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = 'now'; inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      (document.body.querySelector('.trf-btn-primary') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onApplyTimeRange).toHaveBeenCalledTimes(1);
      const [group, from, to] = onApplyTimeRange.mock.calls[0];
      expect(group.key).toBe(GROUP_KEY);
      expect(from).toBe('-1d');
      expect(to).toBe('now');
      bar.el.remove();
    });

    it('an Apply with no onApplyTimeRange wired is a silent no-op (an older/simpler caller)', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, groupParams, () => {}, okField, { timeRange: [trEntry()] });
      document.body.appendChild(bar.el);
      (bar.el.querySelector('.trf-trigger') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const inputs = [...document.body.querySelectorAll('.trf-input')] as HTMLInputElement[];
      inputs[0].value = '-1d'; inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = 'now'; inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      expect(() => (document.body.querySelector('.trf-btn-primary') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
      bar.el.remove();
    });

    it('refreshTimeRangeLabels(nowMs) re-resolves every time-range control label in place; a no-op with no controls', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, groupParams, () => {}, okField, {
        timeRange: [trEntry({ fromValue: '-1d', toValue: 'now', active: true, waveNowMs: 0 })],
      });
      const trigger = bar.el.querySelector('.trf-trigger') as HTMLButtonElement;
      const before = trigger.textContent;
      // A day later — the relative range's resolved absolute bounds move.
      bar.refreshTimeRangeLabels(86_400_000);
      expect(trigger.textContent).not.toBe(before);
      // No time-range controls at all → a harmless no-op.
      const plain = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField);
      expect(() => plain.refreshTimeRangeLabels(1)).not.toThrow();
    });

    it('recents pick applies immediately through onApplyTimeRange after closing', () => {
      const app = makeApp();
      const onApplyTimeRange = vi.fn();
      const recents: TimeRangeRecent[] = [{ from: '-7d', to: 'now' }];
      const bar = buildFilterBar(app, groupParams, () => {}, okField, {
        timeRange: [trEntry({ recents: () => recents })], onApplyTimeRange,
      });
      document.body.appendChild(bar.el);
      (bar.el.querySelector('.trf-trigger') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const recentBtn = document.body.querySelector('.trf-recent') as HTMLButtonElement;
      expect(recentBtn.textContent).toBe('-7d → now');
      recentBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.body.querySelector('.trf-popover')).toBeNull(); // closed first
      expect(onApplyTimeRange).toHaveBeenCalledWith(expect.objectContaining({ key: GROUP_KEY }), '-7d', 'now');
      bar.el.remove();
    });

    // #447: `updateStatus` is the seam a LATER, non-rebuild affordance change
    // lands through. No PLAIN field consumes a status (a direct input has no
    // source to be waiting on), so the only handle it can currently reach is the
    // compound time-range control — whose own `updateStatus` is a documented
    // no-op. The contract under test is the routing, not an affordance.
    it('updateStatus routes a status to the keyed control it built, and ignores every other key', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, groupParams, () => {}, okField, { timeRange: [trEntry()] });
      const trigger = bar.el.querySelector('.trf-trigger') as HTMLButtonElement;
      const before = trigger.textContent;
      // A key this bar DID build a handle for — routed, and a no-op by contract.
      expect(() => bar.updateStatus({ [`group:${GROUP_KEY}`]: { status: 'loading', stale: true } })).not.toThrow();
      // A plain field's parameter name registers no handle; an unrelated key
      // matches nothing. Neither throws, and neither disturbs the built control.
      expect(() => bar.updateStatus({ region: { status: 'waiting', waitingFor: ['x'] } })).not.toThrow();
      expect(() => bar.updateStatus({ nope: { status: 'ready' } })).not.toThrow();
      expect(() => bar.updateStatus({})).not.toThrow();
      expect(bar.el.querySelector('.trf-trigger')).toBe(trigger); // never rebuilt
      expect(trigger.textContent).toBe(before);
      expect(trigger.disabled).toBe(false);
      // A plain field is never disabled or marked by a status update.
      const plainInput = bar.ordinaryEl.querySelector('input') as HTMLInputElement;
      expect(plainInput.disabled).toBe(false);
      expect(plainInput.classList.contains('is-waiting')).toBe(false);
    });
  });

  it('dispose() clears a pending debounce timer so a later value edit never fires the stale commit (#276)', () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      const onCommit = vi.fn();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), onCommit, okField);
      const input = bar.el.querySelector('input')! as HTMLInputElement;
      input.value = 'a';
      input.dispatchEvent(new Event('input', { bubbles: true })); // arms the debounce
      bar.dispose();
      vi.advanceTimersByTime(FILTER_DEBOUNCE_MS + 10);
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() with no pending debounce is a no-op (the never-typed field)', () => {
    const bar = buildFilterBar(makeApp(), paramsFor('SELECT {x:String}'), () => {}, okField);
    expect(() => bar.dispose()).not.toThrow();
  });
});
