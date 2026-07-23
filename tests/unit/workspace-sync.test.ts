import { describe, it, expect } from 'vitest';
import {
  workspaceToken, queryToken, queriesChanged, reconcileLinkedTabs,
} from '../../src/workspace/workspace-sync.js';
import type { LinkedTabSnapshot } from '../../src/workspace/workspace-sync.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryV2, StoredWorkspaceV2 } from '../../src/generated/json-schema.types.js';

const ws = (over: Partial<StoredWorkspaceV2> = {}): StoredWorkspaceV2 => ({
  storageVersion: 2, id: 'w1', key: 'ws', name: 'WS', queries: [], dashboard: null, ...over,
});

const tab = (over: Partial<LinkedTabSnapshot> = {}): LinkedTabSnapshot => ({
  id: 't1', savedId: 'q1', dirtySql: false, dirtySpec: false, lastCommittedQueryToken: '', ...over,
});

describe('workspaceToken', () => {
  it('is empty for a null workspace', () => {
    expect(workspaceToken(null)).toBe('');
  });

  it('is a stable canonical string for a valid workspace, equal iff canonically equal', () => {
    const a = ws({ queries: [savedQuery({ id: 'q1', name: 'One' })] });
    const b = ws({ queries: [savedQuery({ id: 'q1', name: 'One' })] });
    expect(workspaceToken(a)).toBe(workspaceToken(b));
    expect(workspaceToken(a).length).toBeGreaterThan(0);
    expect(workspaceToken(ws({ name: 'Different' }))).not.toBe(workspaceToken(ws()));
  });

  it('collapses an invalid workspace to empty rather than throwing', () => {
    // Unsupported storageVersion fails the codec — token is '' (equality probe,
    // not a validator).
    expect(workspaceToken(ws({ storageVersion: 1 as unknown as 2 }))).toBe('');
  });
});

describe('queryToken', () => {
  it('is order-independent over open fields and equal for equal queries', () => {
    const a = savedQuery({ id: 'q1', name: 'A', favorite: true });
    const b = savedQuery({ id: 'q1', name: 'A', favorite: true });
    expect(queryToken(a)).toBe(queryToken(b));
  });

  it('differs when any query field changes', () => {
    expect(queryToken(savedQuery({ id: 'q1', sql: 'SELECT 1' })))
      .not.toBe(queryToken(savedQuery({ id: 'q1', sql: 'SELECT 2' })));
  });
});

describe('queriesChanged', () => {
  const q = (id: string, sql: string): SavedQueryV2 => savedQuery({ id, sql });

  it('is true when the collections differ in length', () => {
    expect(queriesChanged([], [q('q1', 'a')])).toBe(true);
  });

  it('is true when a query at the same position changed', () => {
    expect(queriesChanged([q('q1', 'a')], [q('q1', 'b')])).toBe(true);
  });

  it('is false for positionally identical collections', () => {
    expect(queriesChanged([q('q1', 'a'), q('q2', 'b')], [q('q1', 'a'), q('q2', 'b')])).toBe(false);
  });
});

describe('reconcileLinkedTabs', () => {
  const q1 = savedQuery({ id: 'q1', sql: 'SELECT 1', name: 'Q1' });
  const q1Changed = savedQuery({ id: 'q1', sql: 'SELECT 2', name: 'Q1' });
  const latest = ws({ queries: [q1Changed] });

  it('noops an unsaved tab (no savedId)', () => {
    const plan = reconcileLinkedTabs(latest, [tab({ savedId: null })]);
    expect(plan).toEqual([{ tabId: 't1', action: 'noop' }]);
  });

  it('noops a linked tab whose saved query is unchanged', () => {
    const plan = reconcileLinkedTabs(latest, [tab({ lastCommittedQueryToken: queryToken(q1Changed) })]);
    expect(plan).toEqual([{ tabId: 't1', action: 'noop' }]);
  });

  it('adopts a clean tab whose saved query changed externally, carrying the latest query', () => {
    const plan = reconcileLinkedTabs(latest, [tab({ lastCommittedQueryToken: queryToken(q1) })]);
    expect(plan).toEqual([{ tabId: 't1', action: 'adopt', query: q1Changed }]);
  });

  it('flags a dirty tab whose saved query changed externally as a conflict', () => {
    const plan = reconcileLinkedTabs(latest, [
      tab({ dirtySql: true, lastCommittedQueryToken: queryToken(q1) }),
    ]);
    expect(plan).toEqual([{ tabId: 't1', action: 'conflict', query: q1Changed }]);
  });

  it('detaches a clean tab whose saved query was deleted', () => {
    const plan = reconcileLinkedTabs(ws({ queries: [] }), [tab({ lastCommittedQueryToken: queryToken(q1) })]);
    expect(plan).toEqual([{ tabId: 't1', action: 'detach' }]);
  });

  it('orphans a dirty tab whose saved query was deleted', () => {
    const plan = reconcileLinkedTabs(ws({ queries: [] }), [
      tab({ dirtySpec: true, lastCommittedQueryToken: queryToken(q1) }),
    ]);
    expect(plan).toEqual([{ tabId: 't1', action: 'orphan' }]);
  });

  it('treats a null latest workspace as every linked query deleted', () => {
    const plan = reconcileLinkedTabs(null, [
      tab({ id: 'clean', dirtySql: false }),
      tab({ id: 'dirty', dirtySpec: true }),
      tab({ id: 'unsaved', savedId: null }),
    ]);
    expect(plan).toEqual([
      { tabId: 'clean', action: 'detach' },
      { tabId: 'dirty', action: 'orphan' },
      { tabId: 'unsaved', action: 'noop' },
    ]);
  });
});
