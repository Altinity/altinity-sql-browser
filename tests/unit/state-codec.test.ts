import { describe, expect, it } from 'vitest';
import {
  decodeStoredVarValues, decodeStoredFilterActive, decodeStoredRecentMap,
  decodeStoredVarRecentDisabled, decodeStoredHistory, HISTORY_MAX_ENTRIES,
} from '../../src/core/state-codec.js';
import { emptyRecentMap } from '../../src/core/recent-values.js';

describe('decodeStoredVarValues (#591)', () => {
  it('fails closed to {} for every non-plain-object top level, never throwing', () => {
    for (const bad of [[], 'x', 5, null, true]) {
      expect(() => decodeStoredVarValues(bad)).not.toThrow();
      expect(decodeStoredVarValues(bad)).toEqual({});
    }
  });

  it('drops malformed entries, keeping the rest', () => {
    expect(decodeStoredVarValues({ a: 'x', b: 42, c: null, d: {}, e: ['y'] })).toEqual({ a: 'x' });
  });

  it('preserves well-formed input, returned as a fresh object', () => {
    const input = { a: 'x', b: 'y' };
    const result = decodeStoredVarValues(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });
});

describe('decodeStoredFilterActive (#591)', () => {
  it('fails closed to {} for every non-plain-object top level', () => {
    for (const bad of [[], 'x', 5, null]) {
      expect(decodeStoredFilterActive(bad)).toEqual({});
    }
  });

  it('drops malformed entries, keeping the rest', () => {
    expect(decodeStoredFilterActive({ a: true, b: false, c: 'true', d: 1, e: null })).toEqual({ a: true, b: false });
  });

  it('preserves well-formed input, returned as a fresh object', () => {
    const input = { a: true, b: false };
    const result = decodeStoredFilterActive(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });
});

describe('decodeStoredRecentMap (#591)', () => {
  it('fails closed to emptyRecentMap() for every non-plain-object top level', () => {
    for (const bad of [[], 'x', 5, null, true]) {
      expect(decodeStoredRecentMap(bad)).toEqual(emptyRecentMap());
    }
  });

  it('fails closed for a wrong or missing version', () => {
    expect(decodeStoredRecentMap({ version: 2, nextSeq: 1, byName: {} })).toEqual(emptyRecentMap());
    expect(decodeStoredRecentMap({ version: '1', nextSeq: 1, byName: {} })).toEqual(emptyRecentMap());
    expect(decodeStoredRecentMap({ nextSeq: 1, byName: {} })).toEqual(emptyRecentMap());
  });

  it('fails closed for a bad nextSeq', () => {
    expect(decodeStoredRecentMap({ version: 1, byName: {} })).toEqual(emptyRecentMap());
    expect(decodeStoredRecentMap({ version: 1, nextSeq: '3', byName: {} })).toEqual(emptyRecentMap());
    expect(decodeStoredRecentMap({ version: 1, nextSeq: 0, byName: {} })).toEqual(emptyRecentMap());
    expect(decodeStoredRecentMap({ version: 1, nextSeq: 1.5, byName: {} })).toEqual(emptyRecentMap());
  });

  it('fails closed when byName is not a plain object', () => {
    expect(decodeStoredRecentMap({ version: 1, nextSeq: 1, byName: [] })).toEqual(emptyRecentMap());
    expect(decodeStoredRecentMap({ version: 1, nextSeq: 1, byName: 'x' })).toEqual(emptyRecentMap());
    expect(decodeStoredRecentMap({ version: 1, nextSeq: 1 })).toEqual(emptyRecentMap());
  });

  it('drops malformed entries and names whose filtered list ends up empty, keeping the rest', () => {
    const result = decodeStoredRecentMap({
      version: 1,
      nextSeq: 5,
      byName: {
        good: [{ value: 'a', seq: 1 }, { value: 2, seq: 2 }, { seq: 3 }, 'junk'],
        badlist: 'nope',
        empties: [{ value: 1, seq: 9 }],
      },
    });
    expect(result).toEqual({ version: 1, nextSeq: 5, byName: { good: [{ value: 'a', seq: 1 }] } });
  });

  it('round-trips well-formed input', () => {
    const input = { version: 1, nextSeq: 3, byName: { a: [{ value: 'x', seq: 2 }] } };
    expect(decodeStoredRecentMap(input)).toEqual(input);
  });

  it('returns a fresh fallback object on every failing call', () => {
    expect(decodeStoredRecentMap(null)).not.toBe(decodeStoredRecentMap(null));
  });

  // Prototype-pollution guard: `byName[name] = filtered` on a plain object
  // literal is a bracket ASSIGNMENT, so name === "__proto__" would invoke
  // Object.prototype's __proto__ setter and swap the object's actual
  // prototype instead of creating an own property — the entry then vanishes
  // from Object.keys/normal enumeration and the result's prototype chain is
  // corrupted. Built via Object.fromEntries (DefineOwnProperty), a
  // "__proto__" name must survive as an ordinary own property with no
  // prototype-chain side effect.
  it('treats a "__proto__" name as an ordinary own property, not a prototype mutation', () => {
    // A literal `__proto__:` key in object-literal syntax has its OWN special
    // prototype-setting semantics in the language itself (it would set the
    // literal's prototype rather than create a property) — a computed key
    // (or JSON.parse, as real persisted values arrive) is required to build
    // an input that actually carries "__proto__" as a genuine own property,
    // the way a real localStorage-parsed value would.
    const stored = JSON.parse(
      '{"version":1,"nextSeq":5,"byName":{"__proto__":[{"value":"x","seq":1}],"safe":[{"value":"y","seq":2}]}}',
    );
    const result = decodeStoredRecentMap(stored);
    expect(Object.getPrototypeOf(result.byName)).toBe(Object.prototype);
    expect(Object.keys(result.byName)).toContain('__proto__');
    expect(result.byName.__proto__).toEqual([{ value: 'x', seq: 1 }]);
    expect(result.byName.safe).toEqual([{ value: 'y', seq: 2 }]);
  });
});

describe('decodeStoredVarRecentDisabled (#591)', () => {
  it('round-trips true and false', () => {
    expect(decodeStoredVarRecentDisabled(true)).toBe(true);
    expect(decodeStoredVarRecentDisabled(false)).toBe(false);
  });

  it('fails closed to false for every non-literal-true value, never coercing', () => {
    for (const bad of ['true', 1, {}, [], null, undefined]) {
      expect(decodeStoredVarRecentDisabled(bad)).toBe(false);
    }
  });
});

describe('decodeStoredHistory (#591)', () => {
  it('fails closed to [] for every non-array top level', () => {
    for (const bad of [{}, 'x', 5, null]) {
      expect(decodeStoredHistory(bad)).toEqual([]);
    }
  });

  it('drops malformed entries, keeping the rest in original order', () => {
    const good1 = { id: 'h1', sql: 'SELECT 1', ts: 1, rows: 1, ms: 2 };
    const good2 = { id: 'h2', sql: 'SELECT 2', ts: 2, rows: null, ms: 3 };
    const result = decodeStoredHistory([
      good1,
      { id: 'missing-fields' },
      'junk',
      null,
      { sql: 'no id', ts: 1, rows: 1, ms: 2 },
      { id: 'h3', sql: 'bad ts', ts: 'nope', rows: 1, ms: 2 },
      good2,
      { id: 'h4', sql: 'bad rows', ts: 1, rows: 'nope', ms: 2 },
    ]);
    expect(result).toEqual([good1, good2]);
  });

  it('accepts rows: null and rows: number, projecting away extra fields', () => {
    const result = decodeStoredHistory([
      { id: 'h1', sql: 'x', ts: 1, rows: null, ms: 2, extra: 'discarded' },
      { id: 'h2', sql: 'y', ts: 1, rows: 3, ms: 2 },
    ]);
    expect(result).toEqual([
      { id: 'h1', sql: 'x', ts: 1, rows: null, ms: 2 },
      { id: 'h2', sql: 'y', ts: 1, rows: 3, ms: 2 },
    ]);
  });

  it(`caps at HISTORY_MAX_ENTRIES (${HISTORY_MAX_ENTRIES})`, () => {
    const input = Array.from({ length: 60 }, (_, i) => ({ id: `h${i}`, sql: 'x', ts: i, rows: 1, ms: 1 }));
    const result = decodeStoredHistory(input);
    expect(result).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(result).toEqual(input.slice(0, HISTORY_MAX_ENTRIES));
  });

  // The "truncated JSON" case from #591's issue Tests section is
  // loadJSON's own parse-failure path, already covered by
  // tests/unit/storage.test.ts — not re-tested here.
});
