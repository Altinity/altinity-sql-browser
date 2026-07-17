import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadJSON, saveJSON, loadStr, saveStr } from '../../src/core/storage.js';

afterEach(() => vi.unstubAllGlobals());

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: unknown) => m.set(k, String(v)),
    _map: m,
  };
}

describe('loadJSON', () => {
  it('returns fallback when store missing', () => {
    expect(loadJSON('k', 'fb', null)).toBe('fb');
  });
  it('returns fallback on miss', () => {
    expect(loadJSON('k', [], memStore())).toEqual([]);
  });
  it('parses stored JSON', () => {
    expect(loadJSON('k', null, memStore({ k: '{"a":1}' }))).toEqual({ a: 1 });
  });
  it('returns fallback on parse error', () => {
    expect(loadJSON('k', 'fb', memStore({ k: '{bad' }))).toBe('fb');
  });
});

describe('saveJSON', () => {
  it('writes JSON', () => {
    const s = memStore();
    saveJSON('k', { a: 1 }, s);
    expect(s._map.get('k')).toBe('{"a":1}');
  });
  it('no-ops without a store', () => {
    expect(() => saveJSON('k', 1, null)).not.toThrow();
  });
  it('swallows setItem errors (quota/disabled)', () => {
    const s = { setItem: vi.fn(() => { throw new Error('quota'); }) };
    expect(() => saveJSON('k', 1, s)).not.toThrow();
  });
});

describe('loadStr / saveStr', () => {
  it('reads raw strings with fallback', () => {
    expect(loadStr('k', 'fb', null)).toBe('fb');
    expect(loadStr('k', 'fb', memStore())).toBe('fb');
    expect(loadStr('k', 'fb', memStore({ k: 'v' }))).toBe('v');
  });
  it('writes raw strings, no-ops without store, swallows errors', () => {
    const s = memStore();
    saveStr('k', 'v', s);
    expect(s._map.get('k')).toBe('v');
    expect(() => saveStr('k', 'v', null)).not.toThrow();
    const bad = { setItem: () => { throw new Error('x'); } };
    expect(() => saveStr('k', 'v', bad)).not.toThrow();
  });
});

describe('default store path', () => {
  it('uses globalThis.localStorage when no store is passed', () => {
    vi.stubGlobal('localStorage', memStore());
    saveJSON('asb:test', { hi: 1 });
    expect(loadJSON('asb:test', null)).toEqual({ hi: 1 });
    saveStr('asb:test2', 'raw');
    expect(loadStr('asb:test2', '')).toBe('raw');
  });

  it('falls back to fallback when localStorage is absent', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadJSON('x', 'fb')).toBe('fb');
    expect(loadStr('x', 'fb')).toBe('fb');
    expect(() => saveJSON('x', 1)).not.toThrow();
    expect(() => saveStr('x', '1')).not.toThrow();
  });

  it('ignores a global without a getItem method', () => {
    vi.stubGlobal('localStorage', {});
    expect(loadJSON('x', 'fb')).toBe('fb');
    expect(loadStr('x', 'fb')).toBe('fb');
  });

  it('survives a localStorage accessor that throws (sandboxed iframe)', () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError'); },
    });
    try {
      expect(loadJSON('x', 'fb')).toBe('fb');
    } finally {
      if (orig) Object.defineProperty(globalThis, 'localStorage', orig);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
