import { describe, expect, it } from 'vitest';
import {
  buildViewHandoffRecord, materializeDetachedWorkspace, resolveDashboardMode,
} from '../../src/dashboard/application/session-bundle.js';
import { encodePortableBundleJson } from '../../src/dashboard/model/portable-bundle-codec.js';
import type {
  DashboardDocumentV1, SavedQueryV2, StoredWorkspaceV2,
} from '../../src/generated/json-schema.types.js';

const panelQuery = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } } } as unknown as SavedQueryV2['spec'],
});

const dashboardDoc = (
  id: string, title: string, tileQueryIds: string[],
): DashboardDocumentV1 => ({
  documentVersion: 1, id, title, revision: 1,
  layout: {
    type: 'flow', version: 1, preset: 'report',
    items: Object.fromEntries(tileQueryIds.map((_, index) => [`${id}-t${index}`, {}])),
  },
  filters: [],
  tiles: tileQueryIds.map((queryId, index) => ({
    id: `${id}-t${index}`, queryId,
  })),
});

describe('buildViewHandoffRecord', () => {
  it('snapshots the dashboard closure, encodes it, and assembles the handoff record', () => {
    const dashboard = dashboardDoc('d1', 'My Dashboard', ['q1']);
    const queries = [panelQuery('q1'), panelQuery('unrelated')];
    const result = buildViewHandoffRecord(dashboard, queries, {
      detachedWorkspaceId: 'detached-1', expiresAt: 1000, nowISO: '2026-07-18T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.dashboardId).toBe('d1');
    expect(result.record.detachedWorkspaceId).toBe('detached-1');
    expect(result.record.expiresAt).toBe(1000);
    const parsed = JSON.parse(result.record.text);
    expect(parsed.dashboards).toHaveLength(1);
    expect(parsed.dashboards[0].id).toBe('d1');
    expect(parsed.queries.map((q: { id: string }) => q.id)).toEqual(['q1']);
  });

  it('returns diagnostics when encoding fails', () => {
    const dashboard = dashboardDoc('d1', 'D', ['q1']);
    const queries = [panelQuery('q1')];
    // An empty nowISO makes encodePortableBundleJson fail its own
    // exportedAt-required check before touching schema validation.
    const result = buildViewHandoffRecord(dashboard, queries, {
      detachedWorkspaceId: 'detached-1', expiresAt: 1000, nowISO: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((d) => d.code === 'schema-required')).toBe(true);
  });
});

describe('materializeDetachedWorkspace', () => {
  const encodedBundle = (dashboard: DashboardDocumentV1, queries: SavedQueryV2[]): string => {
    const encoded = encodePortableBundleJson({
      queries, dashboards: [dashboard], nowISO: '2026-07-18T00:00:00.000Z',
    });
    if (!encoded.ok) throw new Error('fixture bundle failed to encode');
    return encoded.value;
  };

  it('returns diagnostics when the text fails to decode', () => {
    const result = materializeDetachedWorkspace('{bad json', 'd1', 'detached-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('returns a dashboard-not-found diagnostic when the id is absent from the bundle', () => {
    const dashboard = dashboardDoc('d1', 'D', ['q1']);
    const text = encodedBundle(dashboard, [panelQuery('q1')]);
    const result = materializeDetachedWorkspace(text, 'd-missing', 'detached-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      { path: ['dashboards'], severity: 'error', code: 'dashboard-not-found', message: 'Dashboard d-missing not found in bundle' },
    ]);
  });

  it('materializes the selected dashboard into a StoredWorkspaceV2 named after its title', () => {
    const dashboard = dashboardDoc('d1', 'My Dashboard', ['q1']);
    const queries = [panelQuery('q1')];
    const text = encodedBundle(dashboard, queries);
    const result = materializeDetachedWorkspace(text, 'd1', 'detached-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const workspace: StoredWorkspaceV2 = result.workspace;
    expect(workspace.storageVersion).toBe(2);
    expect(workspace.id).toBe('detached-1');
    expect(workspace.key).toBe('detached-1');
    expect(workspace.name).toBe('My Dashboard');
    expect(workspace.dashboard?.id).toBe('d1');
    expect(workspace.queries.map((q) => q.id)).toEqual(['q1']);
  });

  it('falls back to \'Dashboard\' when the selected dashboard has an empty title', () => {
    const dashboard = dashboardDoc('d1', '', ['q1']);
    const queries = [panelQuery('q1')];
    const text = encodedBundle(dashboard, queries);
    const result = materializeDetachedWorkspace(text, 'd1', 'detached-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.name).toBe('Dashboard');
  });
});

describe('resolveDashboardMode', () => {
  const workspaceFixture = (id: string, dashboardId: string | null): StoredWorkspaceV2 => ({
    storageVersion: 2, id, key: `${id}_key`, name: 'WS', queries: [],
    dashboard: dashboardId ? dashboardDoc(dashboardId, 'D', []) : null,
  });

  it('resolves edit mode when the primary workspace and dashboard id both match', () => {
    const primary = workspaceFixture('ws1', 'd1');
    const result = resolveDashboardMode({ kind: 'current-workspace', workspaceKey: 'ws1_key', dashboardId: 'd1' }, primary, null);
    expect(result).toEqual({ mode: 'edit', workspace: primary });
  });

  it('resolves view mode when only the detached workspace and dashboard id match', () => {
    const detached = workspaceFixture('ws1', 'd1');
    const result = resolveDashboardMode({ kind: 'current-workspace', workspaceKey: 'ws1_key', dashboardId: 'd1' }, null, detached);
    expect(result).toEqual({ mode: 'view', workspace: detached });
  });

  it('prefers the primary workspace over the detached workspace when both match', () => {
    const primary = workspaceFixture('ws1', 'd1');
    const detached = workspaceFixture('ws1', 'd1');
    const result = resolveDashboardMode({ kind: 'current-workspace', workspaceKey: 'ws1_key', dashboardId: 'd1' }, primary, detached);
    expect(result).toEqual({ mode: 'edit', workspace: primary });
  });

  it('matches the canonical workspace key case-insensitively', () => {
    const primary = workspaceFixture('ws1', 'd1');
    const result = resolveDashboardMode(
      { kind: 'current-workspace', workspaceKey: 'WS1_KEY', dashboardId: 'd1' },
      primary,
      null,
    );
    expect(result).toEqual({ mode: 'edit', workspace: primary });
  });

  it('returns not-found when neither workspace is loaded', () => {
    const result = resolveDashboardMode({ kind: 'current-workspace', workspaceKey: 'ws1_key', dashboardId: 'd1' }, null, null);
    expect(result).toEqual({ mode: 'not-found' });
  });

  it('returns not-found when the workspace id matches but the dashboard id differs', () => {
    const primary = workspaceFixture('ws1', 'd1');
    const result = resolveDashboardMode({ kind: 'current-workspace', workspaceKey: 'ws1_key', dashboardId: 'd2' }, primary, null);
    expect(result).toEqual({ mode: 'not-found' });
  });

  it('returns not-found when the workspace has no dashboard at all', () => {
    const primary = workspaceFixture('ws1', null);
    const result = resolveDashboardMode({ kind: 'current-workspace', workspaceKey: 'ws1_key', dashboardId: 'd1' }, primary, null);
    expect(result).toEqual({ mode: 'not-found' });
  });

  it('returns not-found when the workspace key differs from both candidates', () => {
    const primary = workspaceFixture('ws-other', 'd1');
    const detached = workspaceFixture('ws-other-2', 'd1');
    const result = resolveDashboardMode({ kind: 'current-workspace', workspaceKey: 'ws1_key', dashboardId: 'd1' }, primary, detached);
    expect(result).toEqual({ mode: 'not-found' });
  });
});
