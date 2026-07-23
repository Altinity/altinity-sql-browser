import { describe, it, expect } from 'vitest';
import {
  parseDashboardOpenSource, buildDashboardSearch,
} from '../../src/dashboard/application/dashboard-open-source.js';
import type { DashboardOpenSource } from '../../src/dashboard/application/dashboard-open-source.js';

describe('parseDashboardOpenSource', () => {
  it('resolves a current-workspace source from ?ws=&dash=', () => {
    expect(parseDashboardOpenSource('?ws=abc&dash=def')).toEqual({
      kind: 'current-workspace', workspaceKey: 'abc', dashboardId: 'def',
    });
  });

  it('resolves a session-bundle source from ?st=&dash=', () => {
    expect(parseDashboardOpenSource('?st=tok123&dash=def')).toEqual({
      kind: 'session-bundle', token: 'tok123', dashboardId: 'def',
    });
  });

  it('prefers st over ws when both are present', () => {
    expect(parseDashboardOpenSource('?st=tok&ws=abc&dash=def')).toEqual({
      kind: 'session-bundle', token: 'tok', dashboardId: 'def',
    });
  });

  it('defaults a missing dash to the empty string', () => {
    expect(parseDashboardOpenSource('?ws=abc')).toEqual({
      kind: 'current-workspace', workspaceKey: 'abc', dashboardId: '',
    });
    expect(parseDashboardOpenSource('?st=tok')).toEqual({
      kind: 'session-bundle', token: 'tok', dashboardId: '',
    });
  });

  it('returns null for the legacy bare /dashboard open (no ws, no st)', () => {
    expect(parseDashboardOpenSource('?dash=def')).toBeNull();
  });

  it('returns null for empty, ?-only, or garbage search strings', () => {
    expect(parseDashboardOpenSource('')).toBeNull();
    expect(parseDashboardOpenSource('?')).toBeNull();
    expect(parseDashboardOpenSource('garbage')).toBeNull();
  });

  it('treats an empty ws or st value as absent (falls through)', () => {
    expect(parseDashboardOpenSource('?ws=&dash=def')).toBeNull();
    expect(parseDashboardOpenSource('?st=&ws=abc&dash=def')).toEqual({
      kind: 'current-workspace', workspaceKey: 'abc', dashboardId: 'def',
    });
  });

  it('URL-decodes ws, st, and dash', () => {
    expect(parseDashboardOpenSource('?ws=a%20b&dash=c%2Fd')).toEqual({
      kind: 'current-workspace', workspaceKey: 'a b', dashboardId: 'c/d',
    });
    expect(parseDashboardOpenSource('?st=tok%2B1&dash=x')).toEqual({
      kind: 'session-bundle', token: 'tok+1', dashboardId: 'x',
    });
  });

  it('ignores the OAuth CSRF `state` param — never treated as a token', () => {
    expect(parseDashboardOpenSource('?state=csrf-value&dash=def')).toBeNull();
    // `state` present alongside a real source must not interfere.
    expect(parseDashboardOpenSource('?state=csrf-value&ws=abc&dash=def')).toEqual({
      kind: 'current-workspace', workspaceKey: 'abc', dashboardId: 'def',
    });
  });

  it('accepts a search string without a leading ?', () => {
    expect(parseDashboardOpenSource('ws=abc&dash=def')).toEqual({
      kind: 'current-workspace', workspaceKey: 'abc', dashboardId: 'def',
    });
  });
});

describe('buildDashboardSearch', () => {
  it('builds ?ws=&dash= for a current-workspace source', () => {
    expect(buildDashboardSearch({ kind: 'current-workspace', workspaceKey: 'abc', dashboardId: 'def' }))
      .toBe('?ws=abc&dash=def');
  });

  it('builds ?st=&dash= for a session-bundle source', () => {
    expect(buildDashboardSearch({ kind: 'session-bundle', token: 'tok123', dashboardId: 'def' }))
      .toBe('?st=tok123&dash=def');
  });

  it('URL-encodes values that need it', () => {
    expect(buildDashboardSearch({ kind: 'current-workspace', workspaceKey: 'a b', dashboardId: 'c/d' }))
      .toBe('?ws=a+b&dash=c%2Fd');
  });

  it('round-trips both kinds through parse', () => {
    const sources: DashboardOpenSource[] = [
      { kind: 'current-workspace', workspaceKey: 'ws-1', dashboardId: 'dash-1' },
      { kind: 'session-bundle', token: 'tok-1', dashboardId: 'dash-1' },
    ];
    for (const source of sources) {
      expect(parseDashboardOpenSource(buildDashboardSearch(source))).toEqual(source);
    }
  });
});
