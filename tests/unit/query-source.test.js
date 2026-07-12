import { describe, it, expect } from 'vitest';
import { buildResultSource } from '../../src/core/query-source.js';

describe('buildResultSource', () => {
  const base = { srcSql: 'SELECT * FROM system.tables', tabId: 't1', rowLimit: 1000 };

  it('uses a saved query name and trimmed description', () => {
    const s = buildResultSource({
      ...base,
      tabName: 'ignored',
      savedEntry: { name: 'Warnings', description: '  emitted by CH  ' },
    });
    expect(s).toEqual({
      sql: 'SELECT * FROM system.tables',
      tabId: 't1',
      rowLimit: 1000,
      title: 'Warnings',
      description: 'emitted by CH',
    });
  });

  it('normalizes a missing saved description to an empty string', () => {
    const s = buildResultSource({ ...base, savedEntry: { name: 'Q' } });
    expect(s.title).toBe('Q');
    expect(s.description).toBe('');
  });

  it('uses the tab name for an unsaved query and no description', () => {
    const s = buildResultSource({ ...base, tabName: 'My scratch query', savedEntry: null });
    expect(s.title).toBe('My scratch query');
    expect(s.description).toBe('');
  });

  it('falls back to inferQueryName when the tab name is the default Untitled', () => {
    const s = buildResultSource({ ...base, tabName: 'Untitled', savedEntry: null });
    expect(s.title).toBe('Query · system.tables');
  });

  it('falls back to inferQueryName when the tab name is blank', () => {
    const s = buildResultSource({ ...base, tabName: '', savedEntry: null });
    expect(s.title).toBe('Query · system.tables');
  });

  it('falls back to inferQueryName when a saved entry name is blank', () => {
    const s = buildResultSource({ ...base, savedEntry: { name: '' } });
    expect(s.title).toBe('Query · system.tables');
  });

  it('falls back to inferQueryName when a saved entry name is the default Untitled', () => {
    const s = buildResultSource({ ...base, savedEntry: { name: 'Untitled' } });
    expect(s.title).toBe('Query · system.tables');
  });

  it('passes the authored SQL through verbatim (optional-block markers intact)', () => {
    const sql = 'SELECT * FROM t /*[ WHERE level = {level:String} ]*/';
    const s = buildResultSource({ srcSql: sql, tabId: 't2', rowLimit: 0, tabName: 'x' });
    expect(s.sql).toBe(sql);
    expect(s.tabId).toBe('t2');
    expect(s.rowLimit).toBe(0);
  });
});
