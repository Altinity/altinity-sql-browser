import { describe, expect, it } from 'vitest';
import {
  findDashboard, findDashboardStrict, replaceDashboard, resolveCompatibilityDashboard,
  withCompatibilityDashboard,
} from '../../src/workspace/workspace-dashboards.js';
import type { DashboardDocumentV1, StoredWorkspaceV4 } from '../../src/generated/json-schema.types.js';

const dash = (id: string, over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  filters: [], tiles: [], ...over,
});
const ws = (dashboards: DashboardDocumentV1[]): StoredWorkspaceV4 => ({
  storageVersion: 4, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards,
});

describe('resolveCompatibilityDashboard', () => {
  it('resolves nothing, the sole entry, or the FIRST of several', () => {
    expect(resolveCompatibilityDashboard(ws([]))).toEqual({ selectedId: null, dashboard: null });

    const only = dash('d1');
    expect(resolveCompatibilityDashboard(ws([only]))).toEqual({ selectedId: 'd1', dashboard: only });

    // Several Dashboards: the current UI deterministically shows the first.
    const first = dash('exec');
    const second = dash('sales');
    expect(resolveCompatibilityDashboard(ws([first, second])))
      .toEqual({ selectedId: 'exec', dashboard: first });
    // …and the resolution follows ARRAY ORDER, not id ordering.
    expect(resolveCompatibilityDashboard(ws([second, first])).selectedId).toBe('sales');
  });

  it('accepts any workspace-shaped value carrying a Dashboard collection', () => {
    expect(resolveCompatibilityDashboard({ dashboards: [dash('d1')] }).selectedId).toBe('d1');
  });
});

describe('findDashboard', () => {
  it('resolves by stable id independent of position, and reports absence', () => {
    const workspace = ws([dash('a'), dash('b')]);
    expect(findDashboard(workspace, 'b')!.id).toBe('b');
    expect(findDashboard(workspace, 'gone')).toBeNull();
    expect(findDashboard(ws([]), 'a')).toBeNull();
  });
});

describe('findDashboardStrict', () => {
  it('resolves a unique id, independent of position', () => {
    const workspace = ws([dash('a'), dash('b')]);
    expect(findDashboardStrict(workspace, 'b'))
      .toEqual({ status: 'ok', dashboard: workspace.dashboards[1] });
  });

  it('separates a deleted entry from an ambiguous one', () => {
    expect(findDashboardStrict(ws([dash('a')]), 'gone')).toEqual({ status: 'missing' });
    expect(findDashboardStrict(ws([]), 'a')).toEqual({ status: 'missing' });
    expect(findDashboardStrict(ws([dash('a'), dash('a')]), 'a')).toEqual({ status: 'duplicate' });
  });

  it('accepts any workspace-shaped value carrying a Dashboard collection', () => {
    expect(findDashboardStrict({ dashboards: [dash('d1')] }, 'd1').status).toBe('ok');
  });
});

describe('replaceDashboard', () => {
  it('replaces exactly one entry and preserves every other, in order', () => {
    const workspace = ws([dash('a'), dash('b'), dash('c')]);
    const next = replaceDashboard(workspace, 'b', dash('b', { revision: 9, title: 'B2' }))!;
    expect(next.dashboards.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(next.dashboards[1].revision).toBe(9);
    // The untargeted entries come through byte-identical, revisions included.
    expect(next.dashboards[0]).toBe(workspace.dashboards[0]);
    expect(next.dashboards[2]).toBe(workspace.dashboards[2]);
    // The envelope is preserved and the input is never mutated.
    expect(next.id).toBe('w1');
    expect(workspace.dashboards[1].revision).toBe(1);
  });

  it('replaces under a DIFFERENT document id when addressed by the old one', () => {
    const next = replaceDashboard(ws([dash('a'), dash('b')]), 'a', dash('imported'))!;
    expect(next.dashboards.map((d) => d.id)).toEqual(['imported', 'b']);
  });

  it('fails — committing nothing — when the id is missing or ambiguous', () => {
    expect(replaceDashboard(ws([dash('a')]), 'gone', dash('gone'))).toBeNull();
    expect(replaceDashboard(ws([]), 'a', dash('a'))).toBeNull();
    // A duplicate-id workspace must never be "repaired" by an ambiguous write.
    expect(replaceDashboard(ws([dash('a'), dash('a')]), 'a', dash('a'))).toBeNull();
  });
});

describe('withCompatibilityDashboard', () => {
  it('appends into an empty collection', () => {
    expect(withCompatibilityDashboard(ws([]), dash('d1')).dashboards.map((d) => d.id)).toEqual(['d1']);
  });

  it('replaces the compatibility SLOT and preserves every later Dashboard', () => {
    const workspace = ws([dash('a'), dash('b'), dash('c')]);
    const next = withCompatibilityDashboard(workspace, dash('imported'));
    expect(next.dashboards.map((d) => d.id)).toEqual(['imported', 'b', 'c']);
    expect(next.dashboards[1]).toBe(workspace.dashboards[1]);
    expect(next.dashboards[2]).toBe(workspace.dashboards[2]);
  });

  it('drops ONLY the compatibility entry for a null document', () => {
    // The reachable case: there was no Dashboard, and there still is none.
    expect(withCompatibilityDashboard(ws([]), null).dashboards).toEqual([]);
    // Explicitly clearing the visible Dashboard never touches the others.
    expect(withCompatibilityDashboard(ws([dash('a'), dash('b')]), null).dashboards.map((d) => d.id))
      .toEqual(['b']);
  });

  it('never mutates its input', () => {
    const workspace = ws([dash('a')]);
    withCompatibilityDashboard(workspace, dash('b'));
    expect(workspace.dashboards.map((d) => d.id)).toEqual(['a']);
  });
});
