import { describe, expect, it } from 'vitest';
import {
  readDashboardVariableBag, writeDashboardVariableBag, variableBagSignature,
} from '../../src/dashboard/model/dashboard-variable-store.js';
import type { DashboardVariableBag } from '../../src/dashboard/model/dashboard-variable-store.js';

describe('readDashboardVariableBag', () => {
  it('round-trips a valid bag for the dashboard id', () => {
    const all = { d1: { f1: { value: 'x', active: true }, f2: { value: '', active: false } } };
    expect(readDashboardVariableBag(all, 'd1')).toEqual({
      f1: { value: 'x', active: true },
      f2: { value: '', active: false },
    });
  });

  it('returns {} for a non-object blob (string, number, array, null, undefined)', () => {
    expect(readDashboardVariableBag('nope', 'd1')).toEqual({});
    expect(readDashboardVariableBag(42, 'd1')).toEqual({});
    expect(readDashboardVariableBag([1, 2], 'd1')).toEqual({});
    expect(readDashboardVariableBag(null, 'd1')).toEqual({});
    expect(readDashboardVariableBag(undefined, 'd1')).toEqual({});
  });

  it('returns {} when the dashboard id is missing from the blob', () => {
    expect(readDashboardVariableBag({ other: { f1: { value: 'x', active: true } } }, 'd1')).toEqual({});
  });

  it('returns {} when the dashboard entry itself is junk (not an object)', () => {
    expect(readDashboardVariableBag({ d1: 'nope' }, 'd1')).toEqual({});
    expect(readDashboardVariableBag({ d1: ['x'] }, 'd1')).toEqual({});
    expect(readDashboardVariableBag({ d1: null }, 'd1')).toEqual({});
  });

  it('drops junk per-filter entries (non-object) while keeping healthy siblings', () => {
    const all = { d1: { f1: { value: 'x', active: true }, f2: 'junk', f3: 42, f4: ['j'], f5: null } };
    expect(readDashboardVariableBag(all, 'd1')).toEqual({ f1: { value: 'x', active: true } });
  });

  it('coerces value to string and active to boolean (number/boolean/missing/nullish)', () => {
    const all = {
      d1: {
        num: { value: 5, active: 1 },
        boolValue: { value: true, active: 0 },
        missingValue: { active: true },
        nullValue: { value: null, active: true },
        undefinedActive: { value: 'v' },
      },
    };
    expect(readDashboardVariableBag(all, 'd1')).toEqual({
      num: { value: '5', active: true },
      boolValue: { value: 'true', active: false },
      missingValue: { value: '', active: true },
      nullValue: { value: '', active: true },
      undefinedActive: { value: 'v', active: false },
    });
  });

  it('round-trips a committed multiselect array value as a NEW array (#189)', () => {
    const all = { d1: { f1: { value: ['a', 'b'], active: true } } };
    const result = readDashboardVariableBag(all, 'd1');
    expect(result).toEqual({ f1: { value: ['a', 'b'], active: true } });
    // Genuine copy, not the same array reference — later mutation of the
    // source blob must not affect the returned bag.
    expect(result.f1.value).not.toBe(all.d1.f1.value);
  });

  it('preserves an empty-string element inside an array value', () => {
    const all = { d1: { f1: { value: ['', 'a'], active: false } } };
    expect(readDashboardVariableBag(all, 'd1')).toEqual({ f1: { value: ['', 'a'], active: false } });
  });

  it('drops non-string/nullish elements from an array value on read (untrusted JSON)', () => {
    const all = { d1: { f1: { value: ['a', 42, null, undefined, true, ['nested'], { x: 1 }, 'b'], active: true } } };
    expect(readDashboardVariableBag(all, 'd1')).toEqual({ f1: { value: ['a', 'b'], active: true } });
  });
});

describe('writeDashboardVariableBag', () => {
  it('replaces the named dashboard bag and preserves other dashboards', () => {
    const all = { d1: { f1: { value: 'old', active: false } }, d2: { g1: { value: 'keep', active: true } } };
    const next = writeDashboardVariableBag(all, 'd1', { f1: { value: 'new', active: true } });
    expect(next).toEqual({
      d1: { f1: { value: 'new', active: true } },
      d2: { g1: { value: 'keep', active: true } },
    });
  });

  it('starts from {} when `all` is not a valid object', () => {
    expect(writeDashboardVariableBag('nope', 'd1', { f1: { value: 'v', active: true } }))
      .toEqual({ d1: { f1: { value: 'v', active: true } } });
    expect(writeDashboardVariableBag(null, 'd1', {})).toEqual({ d1: {} });
    expect(writeDashboardVariableBag(undefined, 'd1', {})).toEqual({ d1: {} });
  });

  it('adds a brand-new dashboard id without any prior entries', () => {
    expect(writeDashboardVariableBag({}, 'd1', { f1: { value: 'v', active: true } }))
      .toEqual({ d1: { f1: { value: 'v', active: true } } });
  });

  it('never mutates the input `all` object or the input `bag`', () => {
    const all = { d1: { f1: { value: 'old', active: false } } };
    const allSnapshot = JSON.parse(JSON.stringify(all));
    const bag: DashboardVariableBag = { f1: { value: 'new', active: true } };
    const bagSnapshot = JSON.parse(JSON.stringify(bag));
    const next = writeDashboardVariableBag(all, 'd1', bag);
    expect(all).toEqual(allSnapshot);
    expect(bag).toEqual(bagSnapshot);
    // The written entry is a genuine copy, not a shared reference — mutating
    // the source bag's entry after the call must not affect the stored result.
    bag.f1.value = 'mutated-after';
    expect(next.d1.f1.value).toBe('new');
  });

  it('clones an array value as a NEW array, not a shared reference', () => {
    const bag: DashboardVariableBag = { f1: { value: ['a', 'b'], active: true } };
    const next = writeDashboardVariableBag({}, 'd1', bag);
    expect(next.d1.f1.value).toEqual(['a', 'b']);
    expect(next.d1.f1.value).not.toBe(bag.f1.value);
    (bag.f1.value as string[]).push('mutated-after');
    expect(next.d1.f1.value).toEqual(['a', 'b']);
  });
});

describe('variableBagSignature', () => {
  it('is stable regardless of key insertion order', () => {
    const a: DashboardVariableBag = { b: { value: '2', active: true }, a: { value: '1', active: false } };
    const b: DashboardVariableBag = { a: { value: '1', active: false }, b: { value: '2', active: true } };
    expect(variableBagSignature(a)).toBe(variableBagSignature(b));
  });

  it('differs when a value or active flag differs', () => {
    const base: DashboardVariableBag = { a: { value: '1', active: false } };
    expect(variableBagSignature(base)).not.toBe(variableBagSignature({ a: { value: '2', active: false } }));
    expect(variableBagSignature(base)).not.toBe(variableBagSignature({ a: { value: '1', active: true } }));
  });

  it('differs when the key set differs, and matches for two empty bags', () => {
    expect(variableBagSignature({})).toBe(variableBagSignature({}));
    expect(variableBagSignature({})).not.toBe(variableBagSignature({ a: { value: '', active: false } }));
  });

  it('distinguishes an array value from its comma-joined string (#189, JSON-safe encoding)', () => {
    const arrayBag: DashboardVariableBag = { a: { value: ['a', 'b'], active: true } };
    const joinedBag: DashboardVariableBag = { a: { value: 'a,b', active: true } };
    expect(variableBagSignature(arrayBag)).not.toBe(variableBagSignature(joinedBag));
    // Matches an equal array value and stays stable across separate calls.
    expect(variableBagSignature(arrayBag)).toBe(variableBagSignature({ a: { value: ['a', 'b'], active: true } }));
  });
});
