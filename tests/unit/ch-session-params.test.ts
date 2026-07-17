import { describe, it, expect, vi } from 'vitest';
import { createChSessionParams } from '../../src/application/ch-session-params.js';
import type { ChSessionCarrier, ChSessionParamsDeps } from '../../src/application/ch-session-params.js';

function makeDeps(over: Partial<ChSessionParamsDeps> = {}): ChSessionParamsDeps & { uid: ReturnType<typeof vi.fn> } {
  let n = 0;
  return {
    uid: vi.fn((prefix: string) => prefix + (++n)),
    ...over,
  } as ChSessionParamsDeps & { uid: ReturnType<typeof vi.fn> };
}

describe('needsSession()', () => {
  it('is true for a CREATE TEMPORARY TABLE statement', () => {
    const { needsSession } = createChSessionParams(makeDeps());
    expect(needsSession(['CREATE TEMPORARY TABLE t (x Int32)'])).toBe(true);
  });

  it('is true for a lowercase temporary keyword too (case-insensitive)', () => {
    const { needsSession } = createChSessionParams(makeDeps());
    expect(needsSession(['create temporary table t (x Int32)'])).toBe(true);
  });

  it('is true when a SET statement leads', () => {
    const { needsSession } = createChSessionParams(makeDeps());
    expect(needsSession(['SET max_threads = 4'])).toBe(true);
  });

  it('is true if ANY statement in the batch needs a session, not just the first', () => {
    const { needsSession } = createChSessionParams(makeDeps());
    expect(needsSession(['SELECT 1', 'SET max_threads = 4', 'SELECT 2'])).toBe(true);
  });

  it('is false for ordinary SELECT/DDL/DML with no TEMPORARY or SET', () => {
    const { needsSession } = createChSessionParams(makeDeps());
    expect(needsSession(['SELECT 1', 'INSERT INTO t VALUES (1)', 'CREATE TABLE t (x Int32) ENGINE=Memory'])).toBe(false);
  });

  it('is false for an empty batch', () => {
    const { needsSession } = createChSessionParams(makeDeps());
    expect(needsSession([])).toBe(false);
  });
});

describe('sessionParams()', () => {
  it('mints a new session_id via uid("sess-") when the tab has none', () => {
    const deps = makeDeps();
    const { sessionParams } = createChSessionParams(deps);
    const tab: ChSessionCarrier = {};
    const result = sessionParams(tab);
    expect(deps.uid).toHaveBeenCalledWith('sess-');
    expect(result).toEqual({ session_id: tab.chSession });
    expect(tab.chSession).toBeTruthy();
  });

  it('is sticky — a later call reuses the same tab.chSession without minting again', () => {
    const deps = makeDeps();
    const { sessionParams } = createChSessionParams(deps);
    const tab: ChSessionCarrier = {};
    const first = sessionParams(tab);
    const second = sessionParams(tab);
    expect(second).toEqual(first);
    expect(deps.uid).toHaveBeenCalledTimes(1);
  });

  it('preserves an already-opened session id set by a prior caller', () => {
    const deps = makeDeps();
    const { sessionParams } = createChSessionParams(deps);
    const tab: ChSessionCarrier = { chSession: 'sess-preexisting' };
    expect(sessionParams(tab)).toEqual({ session_id: 'sess-preexisting' });
    expect(deps.uid).not.toHaveBeenCalled();
  });
});

describe('sessionParamsFor()', () => {
  it('returns {} when the tab has no session and the batch needs none', () => {
    const { sessionParamsFor } = createChSessionParams(makeDeps());
    const tab: ChSessionCarrier = {};
    expect(sessionParamsFor(tab, ['SELECT 1'])).toEqual({});
    expect(tab.chSession).toBeUndefined();
  });

  it('opens a session when the batch needs one', () => {
    const { sessionParamsFor } = createChSessionParams(makeDeps());
    const tab: ChSessionCarrier = {};
    const result = sessionParamsFor(tab, ['SET max_threads = 4']);
    expect(result).toEqual({ session_id: tab.chSession });
    expect(tab.chSession).toBeTruthy();
  });

  it('stays attached (sticky) once a tab has opened a session, even for a batch that no longer needs one', () => {
    const { sessionParamsFor } = createChSessionParams(makeDeps());
    const tab: ChSessionCarrier = { chSession: 'sess-earlier' };
    expect(sessionParamsFor(tab, ['SELECT 1'])).toEqual({ session_id: 'sess-earlier' });
  });
});
