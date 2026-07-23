import { describe, expect, it } from 'vitest';
import {
  deriveWorkspaceKey,
  isValidWorkspaceKey,
  normalizeWorkspaceKeyLookup,
  validateWorkspaceKey,
  WORKSPACE_KEY_PATTERN,
} from '../../src/core/workspace-key.js';

describe('workspace key validation', () => {
  it('accepts only non-empty canonical lowercase ASCII keys beginning alphanumeric', () => {
    for (const key of ['a', '0', 'clickhouse_operations', 'production-eu', 'a_2']) {
      expect(WORKSPACE_KEY_PATTERN.test(key)).toBe(true);
      expect(isValidWorkspaceKey(key)).toBe(true);
      expect(validateWorkspaceKey(key)).toEqual({ ok: true, key });
    }
    for (const key of ['', '_private', '-private', 'Upper', 'with space', 'café', 'a.b']) {
      expect(isValidWorkspaceKey(key)).toBe(false);
    }
    expect(validateWorkspaceKey('')).toEqual({ ok: false, reason: 'required' });
    expect(validateWorkspaceKey(null)).toEqual({ ok: false, reason: 'required' });
    expect(validateWorkspaceKey('UPPER')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('lowercases lookup input without trimming or otherwise repairing it', () => {
    expect(normalizeWorkspaceKeyLookup('Production_EU')).toBe('production_eu');
    expect(normalizeWorkspaceKeyLookup(' Invalid ')).toBe(' invalid ');
  });
});

describe('workspace key derivation', () => {
  it('lowercases ASCII, replaces invalid runs, trims separators, and falls back', () => {
    expect(deriveWorkspaceKey('ClickHouse Operations')).toBe('clickhouse_operations');
    expect(deriveWorkspaceKey('Production EU')).toBe('production_eu');
    expect(deriveWorkspaceKey('__One---Two__')).toBe('one---two');
    expect(deriveWorkspaceKey('  café / 東京  ')).toBe('caf');
    expect(deriveWorkspaceKey('é東京')).toBe('workspace');
    expect(deriveWorkspaceKey(' _ - ')).toBe('workspace');
    expect(deriveWorkspaceKey(undefined)).toBe('workspace');
  });

  it('uses deterministic case-insensitive numeric collision suffixes', () => {
    expect(deriveWorkspaceKey('Operations', ['other'])).toBe('operations');
    expect(deriveWorkspaceKey('Operations', ['OPERATIONS'])).toBe('operations_2');
    expect(deriveWorkspaceKey('Operations', ['operations', 'OPERATIONS_2', 'operations_4']))
      .toBe('operations_3');
    expect(deriveWorkspaceKey('', ['WORKSPACE', 'workspace_2'])).toBe('workspace_3');
  });
});
