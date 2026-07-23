import { describe, expect, it } from 'vitest';
import {
  buildSqlRouteSearch, normalizeSqlRouteSearch, parseSqlRoute, routeForWorkspace,
} from '../../src/core/sql-route.js';

describe('parseSqlRoute', () => {
  it.each([
    ['', { surface: 'workspace', workspaceKey: null }],
    ['?ws=clickhouse_operations', { surface: 'workspace', workspaceKey: 'clickhouse_operations' }],
    ['?ws=x&surface=workspace', { surface: 'workspace', workspaceKey: 'x' }],
    ['?ws=x&surface=unknown&mode=view', { surface: 'workspace', workspaceKey: 'x' }],
    ['?ws=x&surface=dashboard', { surface: 'dashboard', workspaceKey: 'x', mode: 'edit' }],
    ['?ws=x&surface=dashboard&mode=edit', { surface: 'dashboard', workspaceKey: 'x', mode: 'edit' }],
    ['?ws=x&surface=dashboard&mode=unknown', { surface: 'dashboard', workspaceKey: 'x', mode: 'edit' }],
    ['?ws=x&surface=dashboard&mode=view', { surface: 'dashboard', workspaceKey: 'x', mode: 'view' }],
    ['?ws=', { surface: 'workspace', workspaceKey: '' }],
  ] as const)('parses %s', (search, expected) => {
    expect(parseSqlRoute(search)).toEqual(expected);
  });

  it('uses the first repeated parameter value, matching URLSearchParams', () => {
    expect(parseSqlRoute('?ws=first&ws=second&surface=dashboard&surface=workspace')).toEqual({
      surface: 'dashboard', workspaceKey: 'first', mode: 'edit',
    });
  });
});

describe('buildSqlRouteSearch', () => {
  it.each([
    ['?ws=x&surface=workspace', '?ws=x'],
    ['?ws=x&surface=dashboard&mode=edit', '?ws=x&surface=dashboard'],
    ['?ws=x&mode=view', '?ws=x'],
    ['?ws=x&surface=unknown', '?ws=x'],
    ['?ws=x&surface=dashboard&mode=view', '?ws=x&surface=dashboard&mode=view'],
  ])('canonicalizes %s', (input, expected) => {
    const normalized = normalizeSqlRouteSearch(input);
    expect(normalized.search).toBe(expected);
  });

  it('preserves unrelated and OAuth callback parameters', () => {
    const input = '?code=c&state=s&scope=openid&keep=1&ws=x&surface=dashboard&mode=edit';
    expect(normalizeSqlRouteSearch(input).search)
      .toBe('?code=c&state=s&scope=openid&keep=1&ws=x&surface=dashboard');
  });

  it('encodes route values and removes duplicate route-owned parameters', () => {
    expect(buildSqlRouteSearch(
      { surface: 'dashboard', workspaceKey: 'sales eu', mode: 'view' },
      '?ws=a&ws=b&mode=edit&mode=view&keep=yes',
    )).toBe('?keep=yes&ws=sales+eu&surface=dashboard&mode=view');
  });

  it('drops retired detached-dashboard transport parameters', () => {
    expect(normalizeSqlRouteSearch('?ws=x&st=token&dash=old&keep=yes').search)
      .toBe('?keep=yes&ws=x');
  });
});

describe('routeForWorkspace', () => {
  it('preserves the current surface and dashboard mode', () => {
    expect(routeForWorkspace(
      { surface: 'dashboard', workspaceKey: 'a', mode: 'view' }, 'b',
    )).toEqual({ surface: 'dashboard', workspaceKey: 'b', mode: 'view' });
    expect(routeForWorkspace(
      { surface: 'workspace', workspaceKey: 'a' }, 'b',
    )).toEqual({ surface: 'workspace', workspaceKey: 'b' });
  });
});
