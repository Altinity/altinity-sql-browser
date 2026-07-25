import { describe, expect, it } from 'vitest';
import {
  QUERY_SURFACE, isSameDashboardSelection, mainSurfaceRoute, reconcileMainSurface,
  resolveOpenDashboard, selectedDashboardId, withoutFocus,
  type DashboardFocusTarget, type MainSurfaceState,
} from '../../src/application/main-surface.js';
import type { DashboardDocumentV1, StoredWorkspaceV3 } from '../../src/generated/json-schema.types.js';

const dash = (id: string): DashboardDocumentV1 => ({
  documentVersion: 1, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  filters: [], tiles: [],
});
const ws = (ids: string[]): StoredWorkspaceV3 => ({
  storageVersion: 3, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards: ids.map(dash),
});
const onDashboard = (
  dashboardId: string, mode: 'view' | 'edit' = 'edit', focus: DashboardFocusTarget | null = null,
): MainSurfaceState => ({ kind: 'dashboard', dashboardId, mode, focus });

describe('resolveOpenDashboard', () => {
  it('resolves an exact id into Dashboard surface state, independent of position', () => {
    const resolved = resolveOpenDashboard(ws(['a', 'b', 'c']), { dashboardId: 'c', mode: 'view' });
    expect(resolved).toEqual({
      status: 'ok',
      surface: { kind: 'dashboard', dashboardId: 'c', mode: 'view', focus: null },
    });
  });

  it('carries an optional focus target through, defaulting to none', () => {
    const focus = { kind: 'tile', id: 't1' } as const;
    expect(resolveOpenDashboard(ws(['a']), { dashboardId: 'a', mode: 'edit', focus }))
      .toEqual({ status: 'ok', surface: { kind: 'dashboard', dashboardId: 'a', mode: 'edit', focus } });
    expect(resolveOpenDashboard(ws(['a']), { dashboardId: 'a', mode: 'edit' }))
      .toEqual({ status: 'ok', surface: { kind: 'dashboard', dashboardId: 'a', mode: 'edit', focus: null } });
  });

  it('reports a missing id — including against a workspace that has none loaded', () => {
    expect(resolveOpenDashboard(ws(['a']), { dashboardId: 'gone', mode: 'edit' }))
      .toEqual({ status: 'missing' });
    expect(resolveOpenDashboard(ws([]), { dashboardId: 'a', mode: 'edit' }))
      .toEqual({ status: 'missing' });
    expect(resolveOpenDashboard(null, { dashboardId: 'a', mode: 'edit' }))
      .toEqual({ status: 'missing' });
  });

  it('reports a DUPLICATE id separately, so no caller resolves it by a guess', () => {
    expect(resolveOpenDashboard(ws(['a', 'a']), { dashboardId: 'a', mode: 'edit' }))
      .toEqual({ status: 'duplicate' });
  });
});

describe('reconcileMainSurface', () => {
  it('keeps the Query surface untouched', () => {
    expect(reconcileMainSurface(QUERY_SURFACE, ws(['a']))).toBe(QUERY_SURFACE);
  });

  it('keeps a selection the new workspace still resolves uniquely', () => {
    const surface = onDashboard('b', 'view');
    // Same id in a DIFFERENT position — position is never identity.
    expect(reconcileMainSurface(surface, ws(['x', 'b']))).toBe(surface);
  });

  it('falls back to Query mode — never to another Dashboard — when the selection is gone', () => {
    expect(reconcileMainSurface(onDashboard('b'), ws(['a', 'c']))).toBe(QUERY_SURFACE);
    expect(reconcileMainSurface(onDashboard('b'), ws([]))).toBe(QUERY_SURFACE);
    expect(reconcileMainSurface(onDashboard('b'), null)).toBe(QUERY_SURFACE);
  });

  it('falls back to Query mode when the id became ambiguous', () => {
    expect(reconcileMainSurface(onDashboard('b'), ws(['b', 'b']))).toBe(QUERY_SURFACE);
  });
});

describe('mainSurfaceRoute', () => {
  it('maps each surface onto the UNCHANGED /sql route contract', () => {
    expect(mainSurfaceRoute(QUERY_SURFACE, 'ops'))
      .toEqual({ surface: 'workspace', workspaceKey: 'ops' });
    // The selected Dashboard id is session state and never reaches the URL.
    expect(mainSurfaceRoute(onDashboard('sales', 'view'), 'ops'))
      .toEqual({ surface: 'dashboard', workspaceKey: 'ops', mode: 'view' });
    expect(mainSurfaceRoute(onDashboard('sales', 'edit'), null))
      .toEqual({ surface: 'dashboard', workspaceKey: null, mode: 'edit' });
  });
});

describe('selectedDashboardId', () => {
  it('is the id on a Dashboard surface and null in Query mode', () => {
    expect(selectedDashboardId(onDashboard('a'))).toBe('a');
    expect(selectedDashboardId(QUERY_SURFACE)).toBeNull();
  });
});

describe('isSameDashboardSelection', () => {
  it('is true only for the same id in the same mode', () => {
    const surface = onDashboard('a', 'edit');
    expect(isSameDashboardSelection(surface, { dashboardId: 'a', mode: 'edit' })).toBe(true);
    expect(isSameDashboardSelection(surface, { dashboardId: 'a', mode: 'view' })).toBe(false);
    expect(isSameDashboardSelection(surface, { dashboardId: 'b', mode: 'edit' })).toBe(false);
    expect(isSameDashboardSelection(QUERY_SURFACE, { dashboardId: 'a', mode: 'edit' })).toBe(false);
  });
});

describe('withoutFocus', () => {
  it('drops a consumed focus target and keeps the selection', () => {
    const surface = onDashboard('a', 'edit', { kind: 'filter', id: 'f1' });
    expect(withoutFocus(surface)).toEqual({ kind: 'dashboard', dashboardId: 'a', mode: 'edit', focus: null });
  });

  it('returns the same value when there is nothing to clear', () => {
    const already = onDashboard('a');
    expect(withoutFocus(already)).toBe(already);
    expect(withoutFocus(QUERY_SURFACE)).toBe(QUERY_SURFACE);
  });
});
