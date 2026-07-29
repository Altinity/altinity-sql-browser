import { describe, expect, it } from 'vitest';
import { planTabOriginBadges } from '../../src/dashboard/model/tab-origin-badges.js';
import type { StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const workspace = (dashboards: { id: string; title: string; queryIds: string[] }[]): StoredWorkspaceV5 => ({
  id: 'w1', key: 'workspace', name: 'Workspace', storageVersion: 5,
  queries: dashboards.flatMap((dashboard) => dashboard.queryIds.map((id) => ({ id }))),
  dashboards: dashboards.map((dashboard) => ({
    id: dashboard.id, title: dashboard.title,
    tiles: dashboard.queryIds.map((queryId, index) => ({ id: `${dashboard.id}-tile-${index}`, queryId })),
  })),
} as unknown as StoredWorkspaceV5);

describe('planTabOriginBadges', () => {
  it('keeps unique names compact while retaining full source context', () => {
    expect(planTabOriginBadges([
      { id: 'library', name: 'Library query', savedId: 'l1' },
      { id: 'dashboard', name: 'Dashboard query', savedId: 'd1' },
      { id: 'draft', name: 'Untitled', savedId: null },
    ], workspace([{ id: 'ops', title: 'ClickHouse Operations', queryIds: ['d1'] }]))).toEqual([
      { tabId: 'library', kind: 'library', context: 'Library', badge: null },
      { tabId: 'dashboard', kind: 'dashboard', context: 'ClickHouse Operations', badge: null },
      { tabId: 'draft', kind: 'draft', context: 'Draft', badge: null },
    ]);
  });

  it('badges only same-name Library and Dashboard tabs', () => {
    const plans = planTabOriginBadges([
      { id: 'library', name: 'Overview · Live KPIs', savedId: 'l1' },
      { id: 'dashboard', name: 'Overview · Live KPIs', savedId: 'd1' },
      { id: 'unique', name: 'Other', savedId: 'd2' },
    ], workspace([{ id: 'ops', title: 'ClickHouse Operations', queryIds: ['d1', 'd2'] }]));
    expect(plans).toEqual([
      { tabId: 'library', kind: 'library', context: 'Library', badge: 'Library' },
      { tabId: 'dashboard', kind: 'dashboard', context: 'ClickHouse Operations', badge: 'CO' },
      { tabId: 'unique', kind: 'dashboard', context: 'ClickHouse Operations', badge: null },
    ]);
  });

  it('derives Dashboard context for same-named Dashboard-variable tabs', () => {
    const plans = planTabOriginBadges([
      {
        id: 'ops-variable', name: 'Region', savedId: null,
        doc: { kind: 'dashboard-variable', dashboardId: 'ops', variableName: 'region' },
      },
      {
        id: 'prod-variable', name: 'Region', savedId: null,
        doc: { kind: 'dashboard-variable', dashboardId: 'prod', variableName: 'region' },
      },
      { id: 'draft', name: 'Region', savedId: null },
    ], workspace([
      { id: 'ops', title: 'ClickHouse Operations', queryIds: [] },
      { id: 'prod', title: 'Production', queryIds: [] },
    ]));
    expect(plans).toEqual([
      { tabId: 'ops-variable', kind: 'dashboard', context: 'ClickHouse Operations', badge: 'CO' },
      { tabId: 'prod-variable', kind: 'dashboard', context: 'Production', badge: 'Pro' },
      { tabId: 'draft', kind: 'draft', context: 'Draft', badge: 'Draft' },
    ]);
    expect(planTabOriginBadges([{
      id: 'missing-variable', name: 'Region', savedId: null,
      doc: { kind: 'dashboard-variable', dashboardId: 'missing', variableName: 'region' },
    }], workspace([]))).toEqual([
      { tabId: 'missing-variable', kind: 'draft', context: 'Draft', badge: null },
    ]);
  });

  it('extends conflicting Dashboard initialisms deterministically', () => {
    const plans = planTabOriginBadges([
      { id: 'a', name: 'Overview', savedId: 'a1' },
      { id: 'b', name: 'Overview', savedId: 'b1' },
      { id: 'c', name: 'Overview', savedId: 'c1' },
    ], workspace([
      { id: 'first', title: 'ClickHouse Operations', queryIds: ['a1'] },
      { id: 'second', title: 'Cloud Observability', queryIds: ['b1'] },
      { id: 'third', title: 'Production', queryIds: ['c1'] },
    ]));
    expect(plans.map((plan) => plan.badge)).toEqual(['CliO', 'CloO', 'Pro']);
  });

  it('recomputes badges when a collision is closed or renamed', () => {
    const tabs = [
      { id: 'a', name: 'Overview', savedId: 'a1' },
      { id: 'b', name: 'Overview', savedId: 'b1' },
    ];
    const current = workspace([
      { id: 'first', title: 'Analytics', queryIds: ['a1'] },
      { id: 'second', title: 'Billing', queryIds: ['b1'] },
    ]);
    expect(planTabOriginBadges(tabs, current).map((plan) => plan.badge)).toEqual(['Ana', 'Bil']);
    expect(planTabOriginBadges([tabs[0]], current)[0].badge).toBeNull();
    expect(planTabOriginBadges([{ ...tabs[1], name: 'Revenue' }, tabs[0]], current)
      .map((plan) => plan.badge)).toEqual([null, null]);
  });

  it('fails closed to Library for malformed or unavailable ownership', () => {
    expect(planTabOriginBadges([{ id: 'saved', name: 'Same', savedId: 'missing' }], null))
      .toEqual([{ tabId: 'saved', kind: 'library', context: 'Library', badge: null }]);
    const malformed = workspace([
      { id: 'first', title: 'First', queryIds: ['shared'] },
      { id: 'second', title: 'Second', queryIds: ['shared'] },
    ]);
    expect(planTabOriginBadges([
      { id: 'shared', name: 'Same', savedId: 'shared' },
      { id: 'draft', name: 'Same', savedId: null },
    ], malformed)).toEqual([
      { tabId: 'shared', kind: 'library', context: 'Library', badge: 'Library' },
      { tabId: 'draft', kind: 'draft', context: 'Draft', badge: 'Draft' },
    ]);
  });

  it('uses the untitled fallback and does not guess an ambiguous owner Dashboard', () => {
    const current = {
      ...workspace([{ id: 'blank', title: '', queryIds: ['blank-query'] }]),
      dashboards: [{ id: 'blank', title: '   ', tiles: [{ id: 'tile', queryId: 'blank-query' }] }],
    } as unknown as StoredWorkspaceV5;
    expect(planTabOriginBadges([
      { id: 'blank', name: 'Blank', savedId: 'blank-query' },
      { id: 'ambiguous', name: 'Ambiguous', savedId: 'ambiguous-query' },
    ], current)).toEqual([
      { tabId: 'blank', kind: 'dashboard', context: 'Untitled Dashboard', badge: null },
      { tabId: 'ambiguous', kind: 'library', context: 'Library', badge: null },
    ]);
    const ambiguous = {
      ...current,
      dashboards: [
        ...current.dashboards,
        { id: 'blank', title: 'Duplicate', tiles: [{ id: 'second-tile', queryId: 'ambiguous-query' }] },
      ],
    } as unknown as StoredWorkspaceV5;
    expect(planTabOriginBadges([{ id: 'ambiguous', name: 'Ambiguous', savedId: 'ambiguous-query' }], ambiguous)[0])
      .toMatchObject({ kind: 'library', context: 'Library' });
  });

  it('uses stable Dashboard identity only when duplicate titles cannot be extended', () => {
    const plans = planTabOriginBadges([
      { id: 'first-tab', name: 'Same', savedId: 'a1' },
      { id: 'second-tab', name: 'Same', savedId: 'b1' },
    ], workspace([
      { id: 'alpha', title: 'Operations', queryIds: ['a1'] },
      { id: 'alpine', title: 'Operations', queryIds: ['b1'] },
    ]));
    expect(plans.map((plan) => plan.badge)).toEqual(['Operations · alph', 'Operations · alpi']);
  });

  it('uses title text with word boundaries before any id fallback', () => {
    const plans = planTabOriginBadges([
      { id: 'spaced', name: 'Same', savedId: 'a1' },
      { id: 'unspaced', name: 'Same', savedId: 'b1' },
    ], workspace([
      { id: 'spaced-dashboard', title: 'U S A', queryIds: ['a1'] },
      { id: 'unspaced-dashboard', title: 'USA', queryIds: ['b1'] },
    ]));
    expect(plans.map((plan) => plan.badge)).toEqual(['U S A', 'USA']);
    expect(plans.some((plan) => plan.badge?.includes('·'))).toBe(false);
  });
});
