import { describe, it, expect } from 'vitest';
import {
  sameSelection, canonicalizeSelection, reconcileSelection,
} from '../../src/core/variable-selection.js';

// Empty string is a VALID option value throughout — never a sentinel for "no
// selection" (that is an empty array, reduced to unset by the session).
const opts = (...values: string[]): { value: string }[] => values.map((value) => ({ value }));

describe('sameSelection', () => {
  it('compares element-wise, in order', () => {
    expect(sameSelection([], [])).toBe(true);
    expect(sameSelection(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameSelection(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameSelection(['a'], ['a', 'b'])).toBe(false);
    expect(sameSelection(['a', 'b'], ['a'])).toBe(false);
    expect(sameSelection(['a'], ['b'])).toBe(false);
  });

  it('treats an empty-string element as an ordinary value', () => {
    expect(sameSelection([''], [''])).toBe(true);
    expect(sameSelection([''], [])).toBe(false);
  });
});

describe('canonicalizeSelection', () => {
  it('orders by OPTION order, not by the values it was given', () => {
    // The option list is authoritative for display order.
    expect(canonicalizeSelection(['c', 'a'], opts('a', 'b', 'c'))).toEqual(['a', 'c']);
  });

  it('dedupes', () => {
    expect(canonicalizeSelection(['a', 'a', 'b'], opts('a', 'b'))).toEqual(['a', 'b']);
  });

  it('drops a value with no matching option', () => {
    // A dormant value a refresh removed from the list.
    expect(canonicalizeSelection(['a', 'gone'], opts('a', 'b'))).toEqual(['a']);
  });

  it('never introduces a value that was not asked for', () => {
    // A filter/reorder, never an auto-select.
    expect(canonicalizeSelection([], opts('a', 'b'))).toEqual([]);
    expect(canonicalizeSelection(['a'], opts('a', 'b', 'c'))).toEqual(['a']);
  });

  it('keeps an empty-string option value', () => {
    expect(canonicalizeSelection([''], opts('', 'a'))).toEqual(['']);
  });

  it('returns empty against an empty option list', () => {
    expect(canonicalizeSelection(['a'], [])).toEqual([]);
  });
});

describe('reconcileSelection', () => {
  it('PRESERVES the committed order when the option order changes', () => {
    // The committed array becomes an ORDERED ClickHouse literal, and panel SQL is
    // free to read it order-sensitively — `{name:Array(T)}` promises nothing about
    // membership semantics. Re-canonicalizing here would change the value bound
    // into panels whose displayed results came from the old order, and persist
    // that difference, while reporting no wave.
    const r = reconcileSelection(['a', 'b'], opts('b', 'a'));
    expect(r).toEqual({ value: ['a', 'b'], deactivate: false, waveNeeded: false });
  });

  it('preserves committed order among the SURVIVORS too', () => {
    const r = reconcileSelection(['z', 'a', 'b'], opts('a', 'b', 'c'));
    expect(r.value).toEqual(['a', 'b']);
    expect(r.waveNeeded).toBe(true);
  });

  it('needs no wave when the list is unchanged', () => {
    expect(reconcileSelection(['a'], opts('a', 'b')))
      .toEqual({ value: ['a'], deactivate: false, waveNeeded: false });
  });

  it('needs a wave when a selected value disappeared', () => {
    // The bound SET changed, so the panels that declare this variable must re-run.
    expect(reconcileSelection(['a', 'gone'], opts('a', 'b')))
      .toEqual({ value: ['a'], deactivate: false, waveNeeded: true });
  });

  it('deactivates when EVERY selected value disappeared', () => {
    expect(reconcileSelection(['gone', 'also-gone'], opts('a')))
      .toEqual({ value: [], deactivate: true, waveNeeded: true });
  });

  it('does not deactivate when there was nothing selected to begin with', () => {
    // Nothing was contributing, so nothing was lost.
    expect(reconcileSelection([], opts('a')))
      .toEqual({ value: [], deactivate: false, waveNeeded: false });
    expect(reconcileSelection([], []))
      .toEqual({ value: [], deactivate: false, waveNeeded: false });
  });

  it('deactivates when the fresh list is empty and something was selected', () => {
    expect(reconcileSelection(['a'], []))
      .toEqual({ value: [], deactivate: true, waveNeeded: true });
  });

  it('never auto-selects a newly introduced option', () => {
    expect(reconcileSelection(['a'], opts('a', 'brand-new')).value).toEqual(['a']);
  });

  it('counts a DUPLICATE committed value once, so dedupe alone is not a wave', () => {
    // `['a','a']` and `['a']` bind identically; collapsing them must not re-run
    // panels that would receive the exact same array.
    expect(reconcileSelection(['a', 'a'], opts('a')))
      .toEqual({ value: ['a'], deactivate: false, waveNeeded: false });
  });
});
