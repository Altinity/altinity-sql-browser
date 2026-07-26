import { describe, expect, it } from 'vitest';
import {
  QUERY_SURFACE, carryCurrentMember, isSameDashboardSelection, mainSurfaceRoute,
  reconcileMainSurface, resolveOpenDashboard, selectedDashboardId, withCurrentMember,
  withoutPendingFocus,
  type DashboardFocusTarget, type MainSurfaceState,
} from '../../src/application/main-surface.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const dash = (id: string): DashboardDocumentV2 => ({
  documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, tiles: [],
});
/** A Dashboard that actually CONTAINS tile members, for the #426 retention
 *  rules. A `variable` focus target is never validated against the document —
 *  #447 removed the stored filter/variable collection a Dashboard used to
 *  carry, so there is nothing left to construct a fixture "with a variable". */
const dashWith = (id: string, tileIds: string[]): DashboardDocumentV2 => ({
  ...dash(id),
  tiles: tileIds.map((tileId) => ({ id: tileId, queryId: 'q-' + tileId })),
});
const ws = (ids: string[]): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards: ids.map(dash),
});
const wsOf = (...dashboards: DashboardDocumentV2[]): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards,
});
const onDashboard = (
  dashboardId: string, mode: 'view' | 'edit' = 'edit',
  currentMember: DashboardFocusTarget | null = null,
  pendingFocus: DashboardFocusTarget | null = null,
): MainSurfaceState => ({ kind: 'dashboard', dashboardId, mode, currentMember, pendingFocus });

describe('resolveOpenDashboard', () => {
  it('resolves an exact id into Dashboard surface state, independent of position', () => {
    const resolved = resolveOpenDashboard(ws(['a', 'b', 'c']), { dashboardId: 'c', mode: 'view' });
    expect(resolved).toEqual({
      status: 'ok',
      surface: {
        kind: 'dashboard', dashboardId: 'c', mode: 'view', currentMember: null, pendingFocus: null,
      },
    });
  });

  // #426: a member request is TWO facts — which member is now current (styling,
  // retained) and that a delivery is owed (consumed once). One request sets both.
  it('sets BOTH the current member and the owed delivery from one focus request', () => {
    const focus = { kind: 'tile', id: 't1' } as const;
    expect(resolveOpenDashboard(wsOf(dashWith('a', ['t1'])), { dashboardId: 'a', mode: 'edit', focus })).toEqual({
      status: 'ok',
      surface: {
        kind: 'dashboard', dashboardId: 'a', mode: 'edit', currentMember: focus, pendingFocus: focus,
      },
    });
  });

  // The two fields validate differently: styling must not mark a phantom, but the
  // REQUEST has to survive so the delivery path can report the miss.
  it('does not mark a member the Dashboard lacks, but still owes the delivery', () => {
    const focus = { kind: 'tile', id: 'gone' } as const;
    expect(resolveOpenDashboard(wsOf(dashWith('a', ['t1'])), { dashboardId: 'a', mode: 'edit', focus })).toEqual({
      status: 'ok',
      surface: {
        kind: 'dashboard', dashboardId: 'a', mode: 'edit', currentMember: null, pendingFocus: focus,
      },
    });
  });

  // The tree opens a Dashboard ROW with no member; that must CLEAR any previous
  // member rather than leave the old row marked current.
  it('clears the current member when the request names none', () => {
    expect(resolveOpenDashboard(ws(['a']), { dashboardId: 'a', mode: 'edit' })).toEqual({
      status: 'ok',
      surface: {
        kind: 'dashboard', dashboardId: 'a', mode: 'edit', currentMember: null, pendingFocus: null,
      },
    });
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

  // #426 — the Dashboard surviving is not enough: the member it points at may
  // have been removed, and the tree paints current-resource styling from it.
  it('retains a current TILE member the committed document still contains', () => {
    const surface = onDashboard('d', 'edit', { kind: 'tile', id: 't1' });
    expect(reconcileMainSurface(surface, wsOf(dashWith('d', ['t0', 't1'])))).toBe(surface);
  });

  // #447: a VARIABLE is inferred from panel query placeholders, which this pure
  // surface model does not hold — so a variable focus target is retained
  // unconditionally, regardless of what the committed document contains.
  it('always retains a current VARIABLE member — there is nothing to validate it against', () => {
    const surface = onDashboard('d', 'edit', { kind: 'variable', id: 'country' });
    expect(reconcileMainSurface(surface, wsOf(dashWith('d', [])))).toBe(surface);
  });

  it('clears a current TILE member whose tile was removed, keeping the Dashboard open', () => {
    const surface = onDashboard('d', 'edit', { kind: 'tile', id: 'gone' });
    expect(reconcileMainSurface(surface, wsOf(dashWith('d', ['t1'])))).toEqual({
      kind: 'dashboard', dashboardId: 'd', mode: 'edit', currentMember: null, pendingFocus: null,
    });
  });

  // A variable member is retained unconditionally, so it is never resolved
  // against the tile collection — even when its id happens to match a tile id.
  it('does not resolve a tile member by consulting any other collection, and a variable never needs one', () => {
    const tileSurface = onDashboard('d', 'edit', { kind: 'tile', id: 'x' });
    expect(reconcileMainSurface(tileSurface, wsOf(dashWith('d', [])))).toEqual({
      kind: 'dashboard', dashboardId: 'd', mode: 'edit', currentMember: null, pendingFocus: null,
    });
    const variableSurface = onDashboard('d', 'edit', { kind: 'variable', id: 'x' });
    expect(reconcileMainSurface(variableSurface, wsOf(dashWith('d', ['x'])))).toBe(variableSurface);
  });

  // The two fields are independent: a still-valid current member must survive
  // even when the owed delivery has to be dropped.
  it('clears the two member fields INDEPENDENTLY', () => {
    const current = { kind: 'tile', id: 't1' } as const;
    const surface = onDashboard('d', 'edit', current, { kind: 'tile', id: 'gone' });
    expect(reconcileMainSurface(surface, wsOf(dashWith('d', ['t1'])))).toEqual({
      kind: 'dashboard', dashboardId: 'd', mode: 'edit', currentMember: current, pendingFocus: null,
    });
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

describe('withoutPendingFocus', () => {
  // THE #426 CONTRACT: consuming a delivery must not erase the styling. If this
  // also cleared `currentMember`, the tree would stop marking the member the
  // instant its focus ring was delivered.
  it('drops the consumed delivery and RETAINS the current member', () => {
    const member = { kind: 'variable', id: 'country' } as const;
    const surface = onDashboard('a', 'edit', member, member);
    expect(withoutPendingFocus(surface)).toEqual({
      kind: 'dashboard', dashboardId: 'a', mode: 'edit', currentMember: member, pendingFocus: null,
    });
  });

  it('returns the same value when there is nothing to clear', () => {
    const already = onDashboard('a');
    expect(withoutPendingFocus(already)).toBe(already);
    expect(withoutPendingFocus(QUERY_SURFACE)).toBe(QUERY_SURFACE);
  });
});

describe('withCurrentMember', () => {
  // The in-place path delivers focus through the surface command port, so it
  // selects the member WITHOUT owing a render-time delivery.
  it('selects a member without owing a delivery', () => {
    const surface = onDashboard('a', 'view');
    expect(withCurrentMember(surface, { kind: 'tile', id: 't7' })).toEqual({
      kind: 'dashboard', dashboardId: 'a', mode: 'view',
      currentMember: { kind: 'tile', id: 't7' }, pendingFocus: null,
    });
  });

  it('replaces a previously current member', () => {
    const surface = onDashboard('a', 'view', { kind: 'tile', id: 'old' });
    expect(withCurrentMember(surface, { kind: 'variable', id: 'new' })).toEqual({
      kind: 'dashboard', dashboardId: 'a', mode: 'view',
      currentMember: { kind: 'variable', id: 'new' }, pendingFocus: null,
    });
  });

  it('is a no-op in Query mode — there is no Dashboard to select a member in', () => {
    expect(withCurrentMember(QUERY_SURFACE, { kind: 'tile', id: 't1' })).toBe(QUERY_SURFACE);
  });
});

describe('carryCurrentMember', () => {
  // #426: "switching View/Edit through Dashboard chrome preserves the current
  // member where possible". `resolveOpenDashboard` builds the next surface from the
  // request alone, so without this the mode switch silently drops the highlight.
  it('carries the member across a mode change of the SAME Dashboard', () => {
    const member = { kind: 'tile', id: 't1' } as const;
    const previous = onDashboard('a', 'view', member);
    const next = onDashboard('a', 'edit');
    expect(carryCurrentMember(previous, next)).toEqual({
      kind: 'dashboard', dashboardId: 'a', mode: 'edit', currentMember: member, pendingFocus: null,
    });
  });

  it('does NOT carry across a different Dashboard', () => {
    const previous = onDashboard('a', 'view', { kind: 'tile', id: 't1' });
    const next = onDashboard('b', 'view');
    expect(carryCurrentMember(previous, next)).toBe(next);
  });

  it('does NOT override a member the request named itself', () => {
    const previous = onDashboard('a', 'view', { kind: 'tile', id: 'old' });
    const next = onDashboard('a', 'edit', { kind: 'tile', id: 'new' });
    expect(carryCurrentMember(previous, next)).toBe(next);
  });

  it('is a no-op when there was no member, or either side is Query mode', () => {
    expect(carryCurrentMember(onDashboard('a'), onDashboard('a', 'edit')))
      .toEqual(onDashboard('a', 'edit'));
    const next = onDashboard('a', 'edit');
    expect(carryCurrentMember(QUERY_SURFACE, next)).toBe(next);
    expect(carryCurrentMember(onDashboard('a', 'view', { kind: 'tile', id: 't1' }), QUERY_SURFACE))
      .toBe(QUERY_SURFACE);
  });
});
