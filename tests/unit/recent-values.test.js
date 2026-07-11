import { describe, it, expect } from 'vitest';
import {
  emptyRecentMap, recordRecent, clearRecent, clearAllRecent, visibleRecents,
  filterRecentValues, recentOptions, VAR_RECENT_PER_NAME_CAP, VAR_RECENT_TOTAL_CAP,
} from '../../src/core/recent-values.js';

describe('emptyRecentMap', () => {
  it('starts empty, versioned, seq at 1', () => {
    expect(emptyRecentMap()).toEqual({ version: 1, nextSeq: 1, byName: {} });
  });
});

describe('recordRecent', () => {
  it('creates a fresh map when given undefined', () => {
    const m = recordRecent(undefined, 'tenant', 'acme');
    expect(m).toEqual({ version: 1, nextSeq: 2, byName: { tenant: [{ value: 'acme', seq: 1 }] } });
  });
  it('inserts newest-first', () => {
    let m = recordRecent(emptyRecentMap(), 'tenant', 'a');
    m = recordRecent(m, 'tenant', 'b');
    expect(m.byName.tenant.map((e) => e.value)).toEqual(['b', 'a']);
  });
  it('move-to-front + exact-string dedupe on a re-used value (no duplicate entry)', () => {
    let m = recordRecent(emptyRecentMap(), 'tenant', 'a');
    m = recordRecent(m, 'tenant', 'b');
    m = recordRecent(m, 'tenant', 'a');
    expect(m.byName.tenant.map((e) => e.value)).toEqual(['a', 'b']);
    expect(m.byName.tenant).toHaveLength(2);
  });
  it('caps at VAR_RECENT_PER_NAME_CAP per name — the oldest is dropped', () => {
    let m = emptyRecentMap();
    for (let i = 0; i < VAR_RECENT_PER_NAME_CAP + 1; i++) m = recordRecent(m, 'tenant', 'v' + i);
    expect(m.byName.tenant).toHaveLength(VAR_RECENT_PER_NAME_CAP);
    expect(m.byName.tenant.map((e) => e.value)).toEqual(
      Array.from({ length: VAR_RECENT_PER_NAME_CAP }, (_, i) => 'v' + (VAR_RECENT_PER_NAME_CAP - i)),
    );
    expect(m.byName.tenant.some((e) => e.value === 'v0')).toBe(false); // the oldest is gone
  });
  it('empty string is never recorded — returns the map unchanged (same reference)', () => {
    const m0 = emptyRecentMap();
    expect(recordRecent(m0, 'tenant', '')).toBe(m0);
    expect(recordRecent(m0, 'tenant', null)).toBe(m0);
    expect(recordRecent(m0, 'tenant', undefined)).toBe(m0);
  });
  it('empty string against an undefined map yields a fresh empty map, not a throw', () => {
    expect(recordRecent(undefined, 'tenant', '')).toEqual(emptyRecentMap());
  });
  it('total-cap global-LRU eviction: the globally-oldest entries are dropped once over VAR_RECENT_TOTAL_CAP, regardless of name', () => {
    let m = emptyRecentMap();
    // 11 names × 10 values each = 110 entries, 10 over the 100 cap. Every
    // per-name list is already at its own 10-cap, so the total overshoot can
    // only be resolved by evicting across names (the lowest global seq —
    // name0's very first values, recorded before anything else).
    for (let n = 0; n < 11; n++) {
      for (let v = 0; v < 10; v++) m = recordRecent(m, 'name' + n, 'v' + v);
    }
    let total = 0;
    for (const name in m.byName) total += m.byName[name].length;
    expect(total).toBe(VAR_RECENT_TOTAL_CAP);
    // name0's oldest values (v0..v9, recorded first — lowest seq) are exactly
    // the 10 evicted; name0 itself drops out of byName entirely.
    expect(m.byName.name0).toBeUndefined();
    // Every later name survives intact at its own per-name cap.
    for (let n = 1; n < 11; n++) expect(m.byName['name' + n]).toHaveLength(10);
  });
  it('total-cap eviction can leave a name with a partial list (not just whole-name drops)', () => {
    let m = emptyRecentMap();
    // One name with exactly TOTAL_CAP entries, then one more distinct name/value
    // pushes total to CAP+1 — the single globally-oldest entry (name 'a''s v0) is
    // evicted, leaving 'a' with 9 entries instead of disappearing outright.
    for (let v = 0; v < VAR_RECENT_TOTAL_CAP; v++) {
      m = recordRecent(m, 'a' + Math.floor(v / VAR_RECENT_PER_NAME_CAP), 'v' + v);
    }
    let total = 0;
    for (const name in m.byName) total += m.byName[name].length;
    expect(total).toBe(VAR_RECENT_TOTAL_CAP);
    m = recordRecent(m, 'zzz', 'new');
    total = 0;
    for (const name in m.byName) total += m.byName[name].length;
    expect(total).toBe(VAR_RECENT_TOTAL_CAP);
    expect(m.byName.a0).toHaveLength(VAR_RECENT_PER_NAME_CAP - 1); // the oldest one entry gone
    expect(m.byName.a0.some((e) => e.value === 'v0')).toBe(false);
    expect(m.byName.zzz.map((e) => e.value)).toEqual(['new']);
  });
});

describe('clearRecent', () => {
  it('clears one name, leaving others untouched', () => {
    let m = recordRecent(emptyRecentMap(), 'a', '1');
    m = recordRecent(m, 'b', '2');
    const cleared = clearRecent(m, 'a');
    expect(cleared.byName.a).toBeUndefined();
    expect(cleared.byName.b.map((e) => e.value)).toEqual(['2']);
  });
  it('is a no-op (same reference) for a name with no history', () => {
    const m = recordRecent(emptyRecentMap(), 'a', '1');
    expect(clearRecent(m, 'nope')).toBe(m);
  });
  it('tolerates an undefined map', () => {
    expect(clearRecent(undefined, 'a')).toEqual(emptyRecentMap());
  });
});

describe('clearAllRecent', () => {
  it('resets to a fresh empty map', () => {
    expect(clearAllRecent()).toEqual(emptyRecentMap());
  });
});

describe('visibleRecents — type-filtering hides, never deletes', () => {
  it('hides a recent that is invalid for the current declared type', () => {
    let m = recordRecent(emptyRecentMap(), 'id', 'abc'); // not a valid UInt8
    m = recordRecent(m, 'id', '5');
    expect(visibleRecents(m, 'id', 'UInt8')).toEqual(['5']);
    // Still present in storage, just hidden for this type — reappears under a
    // compatible declaration.
    expect(m.byName.id.map((e) => e.value)).toEqual(['5', 'abc']);
    expect(visibleRecents(m, 'id', 'String')).toEqual(['5', 'abc']);
  });
  it('passes valid/incomplete/unknown, only hides invalid', () => {
    let m = recordRecent(emptyRecentMap(), 'n', '-'); // Int8 'incomplete'
    m = recordRecent(m, 'n', '42'); // Int8 'valid'
    m = recordRecent(m, 'n', '9999'); // Int8 range 'invalid'
    expect(visibleRecents(m, 'n', 'Int8')).toEqual(['42', '-']);
  });
  it('an unknown name yields an empty list', () => {
    expect(visibleRecents(emptyRecentMap(), 'nope', 'String')).toEqual([]);
  });
  it('tolerates an undefined map', () => {
    expect(visibleRecents(undefined, 'nope', 'String')).toEqual([]);
  });
});

describe('filterRecentValues', () => {
  it('blank query returns the list unchanged (same reference)', () => {
    const list = ['a', 'b'];
    expect(filterRecentValues(list, '')).toBe(list);
    expect(filterRecentValues(list, '   ')).toBe(list);
    expect(filterRecentValues(list, undefined)).toBe(list);
  });
  it('case-insensitive substring match', () => {
    expect(filterRecentValues(['acme-prod', 'ACME-DEV', 'other'], 'acme')).toEqual(['acme-prod', 'ACME-DEV']);
  });
  it('no match yields an empty list', () => {
    expect(filterRecentValues(['a', 'b'], 'zzz')).toEqual([]);
  });
});

describe('recentOptions', () => {
  it('composes type-filtering and text-filtering', () => {
    let m = recordRecent(emptyRecentMap(), 'tenant', 'acme');
    m = recordRecent(m, 'tenant', 'other');
    expect(recentOptions(m, 'tenant', 'String', 'ac')).toEqual(['acme']);
  });
  it('type-filters before text-filters (an invalid-for-type value never matches even a blank query)', () => {
    let m = recordRecent(emptyRecentMap(), 'id', 'abc');
    m = recordRecent(m, 'id', '5');
    expect(recentOptions(m, 'id', 'UInt8', '')).toEqual(['5']);
  });
});
