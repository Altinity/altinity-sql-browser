import { describe, expect, it } from 'vitest';
import {
  autoResolveConflicts, buildQueryIdMapping, detectQueryConflicts, listBundleDashboards,
  planImportDashboard, planImportQueries, planReplaceWorkspace, rewriteDashboardReferences,
} from '../../src/workspace/import-planner.js';
import type {
  IdMapping, QueryConflict, QueryDecision,
} from '../../src/workspace/import-planner.js';
import type {
  DashboardDocumentV1, PortableBundleV1, SavedQueryV2, StoredWorkspaceV1,
} from '../../src/generated/json-schema.types.js';

// --- fixtures ----------------------------------------------------------------

const panelQuery = (id: string, name = id): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { name, panel: { cfg: { type: 'bar', x: 0, y: [1] } } },
});

const filterQuery = (id: string, name = id): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { name, dashboard: { role: 'filter' } },
});

const dashboardDoc = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  filters: [], tiles: [], ...over,
});

const workspace = (over: Partial<StoredWorkspaceV1> = {}): StoredWorkspaceV1 => ({
  storageVersion: 1, id: 'w1', name: 'Workspace', queries: [], dashboard: null, ...over,
});

const bundle = (over: Partial<PortableBundleV1> = {}): PortableBundleV1 => ({
  format: 'altinity-sql-browser/portable-bundle', version: 1,
  exportedAt: '2026-07-17T00:00:00.000Z', queries: [], dashboards: [], ...over,
});

// A deterministic counter ID generator for the tests.
const counter = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const ids = (queries: readonly SavedQueryV2[]): string[] => queries.map((q) => q.id);

// --- listBundleDashboards -----------------------------------------------------

describe('listBundleDashboards', () => {
  it('preserves bundle.dashboards ARRAY ORDER (no re-sort)', () => {
    const zeta = dashboardDoc({
      id: 'zeta', title: 'Zeta', tiles: [{ id: 't1', queryId: 'p1' }], filters: [],
    });
    const alpha = dashboardDoc({
      id: 'alpha', title: 'Alpha', filters: [{ id: 'f1', parameter: 'p' }],
    });
    const summaries = listBundleDashboards(bundle({ dashboards: [zeta, alpha] }));
    expect(summaries).toEqual([
      { id: 'zeta', title: 'Zeta', tileCount: 1, filterCount: 0 },
      { id: 'alpha', title: 'Alpha', tileCount: 0, filterCount: 1 },
    ]);
  });

  it('returns an empty summary list for an empty bundle', () => {
    expect(listBundleDashboards(bundle())).toEqual([]);
  });
});

// --- detectQueryConflicts / autoResolveConflicts ------------------------------

describe('detectQueryConflicts', () => {
  it('matches BY ID ONLY, and flags canonicalEqual per matched pair', () => {
    const existing = [panelQuery('a'), panelQuery('b', 'B existing')];
    const incoming = [panelQuery('a'), panelQuery('b', 'B incoming'), panelQuery('c')];
    const conflicts = detectQueryConflicts(existing, incoming);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toEqual({
      sourceId: 'a', existing: existing[0], incoming: incoming[0], canonicalEqual: true,
    });
    expect(conflicts[1].sourceId).toBe('b');
    expect(conflicts[1].canonicalEqual).toBe(false);
  });

  it('reports no conflicts when no ids match', () => {
    expect(detectQueryConflicts([panelQuery('a')], [panelQuery('b')])).toEqual([]);
  });
});

describe('autoResolveConflicts', () => {
  it('auto-resolves ONLY canonically-equal conflicts to use-existing; non-equal ones are omitted', () => {
    const conflicts: QueryConflict[] = [
      { sourceId: 'a', existing: panelQuery('a'), incoming: panelQuery('a'), canonicalEqual: true },
      { sourceId: 'b', existing: panelQuery('b'), incoming: panelQuery('b', 'different'), canonicalEqual: false },
    ];
    expect(autoResolveConflicts(conflicts)).toEqual([
      { sourceId: 'a', action: 'use-existing', targetId: 'a' },
    ]);
  });
});

// --- buildQueryIdMapping -------------------------------------------------------

describe('buildQueryIdMapping', () => {
  it('keeps a non-conflicting incoming query under its own id (action copy)', () => {
    const mapping = buildQueryIdMapping([panelQuery('x')], [], [], counter());
    expect(mapping).toEqual({ x: { targetId: 'x', action: 'copy' } });
  });

  it('defaults an undecided conflict to skip', () => {
    const mapping = buildQueryIdMapping([panelQuery('a')], [panelQuery('a')], [], counter());
    expect(mapping.a).toEqual({ targetId: null, action: 'skip' });
  });

  it('honors an explicit skip decision on a conflict', () => {
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'skip' }];
    const mapping = buildQueryIdMapping([panelQuery('a')], [panelQuery('a')], decisions, counter());
    expect(mapping.a).toEqual({ targetId: null, action: 'skip' });
  });

  it('honors use-existing and replace decisions under the shared conflict id', () => {
    const decisions: QueryDecision[] = [
      { sourceId: 'a', action: 'use-existing' }, { sourceId: 'b', action: 'replace' },
    ];
    const mapping = buildQueryIdMapping(
      [panelQuery('a'), panelQuery('b')], [panelQuery('a'), panelQuery('b')], decisions, counter(),
    );
    expect(mapping.a).toEqual({ targetId: 'a', action: 'use-existing' });
    expect(mapping.b).toEqual({ targetId: 'b', action: 'replace' });
  });

  it('honors a caller-preferred fresh copy targetId when it is free', () => {
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'copy', targetId: 'a-copy' }];
    const mapping = buildQueryIdMapping([panelQuery('a')], [panelQuery('a')], decisions, counter());
    expect(mapping.a).toEqual({ targetId: 'a-copy', action: 'copy' });
  });

  it('mints a fresh id via genId when a copy decision omits targetId', () => {
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'copy' }];
    const mapping = buildQueryIdMapping([panelQuery('a')], [panelQuery('a')], decisions, counter('fresh'));
    expect(mapping.a).toEqual({ targetId: 'fresh-1', action: 'copy' });
  });

  it('falls back to genId when the requested copy targetId collides, retrying past collisions', () => {
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'copy', targetId: 'a' }]; // 'a' is taken (existing)
    let calls = 0;
    const genId = () => { calls += 1; return calls === 1 ? 'a' /* still taken */ : 'fresh-2'; };
    const mapping = buildQueryIdMapping([panelQuery('a')], [panelQuery('a')], decisions, genId);
    expect(mapping.a).toEqual({ targetId: 'fresh-2', action: 'copy' });
    expect(calls).toBe(2);
  });

  it('never mints the same fresh id twice within one call, even if two decisions request the same free id', () => {
    const decisions: QueryDecision[] = [
      { sourceId: 'a', action: 'copy', targetId: 'new' },
      { sourceId: 'b', action: 'copy', targetId: 'new' },
    ];
    const genId = counter('minted');
    const mapping = buildQueryIdMapping(
      [panelQuery('a'), panelQuery('b')], [panelQuery('a'), panelQuery('b')], decisions, genId,
    );
    expect(mapping.a).toEqual({ targetId: 'new', action: 'copy' });
    expect(mapping.b.targetId).not.toBe('new');
    expect(mapping.b.action).toBe('copy');
  });

  it('throws when genId can never produce a free id within the retry budget', () => {
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'copy' }];
    expect(() => buildQueryIdMapping([panelQuery('a')], [panelQuery('a')], decisions, () => 'a')).toThrow();
  });
});

// --- rewriteDashboardReferences ------------------------------------------------

describe('rewriteDashboardReferences', () => {
  const dashboard = dashboardDoc({
    tiles: [{ id: 't1', queryId: 'p1' }],
    filters: [{ id: 'flt1', parameter: 'p', sourceQueryId: 'f1' }, { id: 'flt2', parameter: 'q' }],
    layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
  });

  it('rewrites BOTH tile.queryId and filter.sourceQueryId via an IdMapping', () => {
    const mapping: IdMapping = {
      p1: { targetId: 'p1-copy', action: 'copy' },
      f1: { targetId: 'f1-copy', action: 'copy' },
    };
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(false);
    expect(result.missingRequiredIds).toEqual([]);
    expect(result.dashboard.tiles[0].queryId).toBe('p1-copy');
    expect(result.dashboard.filters[0].sourceQueryId).toBe('f1-copy');
    expect(result.dashboard.filters[1].sourceQueryId).toBeUndefined(); // no sourceQueryId — untouched
  });

  it('rewrites via a plain Map<string,string|null> too', () => {
    const mapping = new Map<string, string | null>([['p1', 'p2'], ['f1', 'f2']]);
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(false);
    expect(result.dashboard.tiles[0].queryId).toBe('p2');
    expect(result.dashboard.filters[0].sourceQueryId).toBe('f2');
  });

  it('invalidates when a required reference maps to null (skipped)', () => {
    const mapping: IdMapping = {
      p1: { targetId: null, action: 'skip' },
      f1: { targetId: 'f1', action: 'use-existing' },
    };
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(true);
    expect(result.missingRequiredIds).toEqual(['p1']);
    // Never silently dropped — the original reference is retained.
    expect(result.dashboard.tiles[0].queryId).toBe('p1');
  });

  it('invalidates when a required reference has no mapping entry at all (Map variant, too)', () => {
    const mapping = new Map<string, string | null>([['f1', 'f1']]); // p1 absent
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(true);
    expect(result.missingRequiredIds).toEqual(['p1']);
  });

  it('invalidates when a required reference has no IdMapping (Record) entry at all', () => {
    const mapping: IdMapping = { f1: { targetId: 'f1', action: 'use-existing' } }; // p1 absent
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(true);
    expect(result.missingRequiredIds).toEqual(['p1']);
  });

  it('never mutates the input dashboard (deep clone)', () => {
    const mapping: IdMapping = { p1: { targetId: 'p2', action: 'copy' }, f1: { targetId: 'f1', action: 'use-existing' } };
    const result = rewriteDashboardReferences(dashboard, mapping);
    result.dashboard.tiles[0].queryId = 'mutated';
    expect(dashboard.tiles[0].queryId).toBe('p1');
  });
});

// --- planImportQueries ---------------------------------------------------------

describe('planImportQueries', () => {
  it('imports a non-conflicting query and leaves the Dashboard byte-for-byte unchanged', () => {
    const dash = dashboardDoc();
    const ws = workspace({ queries: [panelQuery('a')], dashboard: dash });
    const plan = planImportQueries(ws, bundle({ queries: [panelQuery('b')] }), [], counter());
    expect(plan.candidateWorkspace).not.toBeNull();
    expect(ids(plan.candidateWorkspace!.queries)).toEqual(['a', 'b']);
    expect(plan.candidateWorkspace!.dashboard).toBe(dash);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.sourceDashboardId).toBeUndefined();
  });

  it('overwrites the existing entry in place on a replace decision', () => {
    const ws = workspace({ queries: [panelQuery('a', 'old name')] });
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'replace' }];
    const plan = planImportQueries(ws, bundle({ queries: [panelQuery('a', 'new name')] }), decisions, counter());
    expect(ids(plan.candidateWorkspace!.queries)).toEqual(['a']);
    expect(plan.candidateWorkspace!.queries[0].spec.name).toBe('new name');
  });

  it('allows skip on a conflicting query with no Dashboard dependency (queries-only skip is fine)', () => {
    const ws = workspace({ queries: [panelQuery('a')] });
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'skip' }];
    const plan = planImportQueries(ws, bundle({ queries: [panelQuery('a', 'incoming')] }), decisions, counter());
    expect(plan.candidateWorkspace).not.toBeNull();
    expect(ids(plan.candidateWorkspace!.queries)).toEqual(['a']);
    expect(plan.candidateWorkspace!.queries[0].spec.name).toBe('a'); // existing content retained
  });

  it('use-existing keeps the existing entry and does not duplicate it', () => {
    const ws = workspace({ queries: [panelQuery('a', 'existing')] });
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'use-existing' }];
    const plan = planImportQueries(ws, bundle({ queries: [panelQuery('a', 'incoming')] }), decisions, counter());
    expect(ids(plan.candidateWorkspace!.queries)).toEqual(['a']);
    expect(plan.candidateWorkspace!.queries[0].spec.name).toBe('existing');
  });

  it('returns candidateWorkspace: null with sorted diagnostics when the candidate fails validation', () => {
    const ws = workspace();
    const badQuery = { id: 'a', sql: 'SELECT 1', specVersion: 9, spec: {} } as unknown as SavedQueryV2;
    const plan = planImportQueries(ws, bundle({ queries: [badQuery] }), [], counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics.length).toBeGreaterThan(0);
    expect(plan.diagnostics.some((d) => d.code === 'spec-version-unsupported')).toBe(true);
  });
});

// --- planImportDashboard --------------------------------------------------------

describe('planImportDashboard', () => {
  // t1's query (p1) declares `{p:String}` so the source-backed filter `flt1`
  // (`sourceQueryId: 'f1'`) has a valid selection-contract consumer — #189/
  // #360's `resolveFilterSelection`, now run by `validateDashboardSemantics`
  // for every source-backed filter, would otherwise flag zero consumers.
  // This suite is about ID-rewriting through import, not filter contracts.
  const buildBundle = () => bundle({
    queries: [{ ...panelQuery('p1', 'incoming p1'), sql: 'SELECT {p:String}' }, filterQuery('f1', 'incoming f1')],
    dashboards: [dashboardDoc({
      id: 'd1', revision: 5,
      tiles: [{ id: 't1', queryId: 'p1' }],
      filters: [{ id: 'flt1', parameter: 'p', sourceQueryId: 'f1' }],
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
    })],
  });

  it('copy mode rewrites BOTH tile.queryId and filter.sourceQueryId, mints a fresh Dashboard id, and resets revision to 1', () => {
    const ws = workspace({ queries: [panelQuery('p1', 'existing p1'), filterQuery('f1', 'existing f1')] });
    const decisions: QueryDecision[] = [
      { sourceId: 'p1', action: 'copy', targetId: 'p1-copy' },
      { sourceId: 'f1', action: 'copy', targetId: 'f1-copy' },
    ];
    const genId = counter('new-dash');
    const plan = planImportDashboard(ws, buildBundle(), 'd1', decisions, 'copy', genId);
    expect(plan.diagnostics).toEqual([]);
    const candidate = plan.candidateWorkspace!;
    expect(candidate.dashboard!.id).toBe('new-dash-1');
    expect(candidate.dashboard!.revision).toBe(1);
    expect(candidate.dashboard!.tiles[0].queryId).toBe('p1-copy');
    expect(candidate.dashboard!.filters[0].sourceQueryId).toBe('f1-copy');
    // existing catalog entries keep their position; new copies are appended.
    expect(ids(candidate.queries)).toEqual(['p1', 'f1', 'p1-copy', 'f1-copy']);
    expect(plan.sourceDashboardId).toBe('d1');
  });

  it('replace mode keeps the imported Dashboard id and revision', () => {
    const ws = workspace(); // no existing queries — both incoming ids are non-conflicting
    const plan = planImportDashboard(ws, buildBundle(), 'd1', [], 'replace', counter());
    const candidate = plan.candidateWorkspace!;
    expect(candidate.dashboard!.id).toBe('d1');
    expect(candidate.dashboard!.revision).toBe(5);
    expect(candidate.dashboard!.tiles[0].queryId).toBe('p1');
    expect(candidate.dashboard!.filters[0].sourceQueryId).toBe('f1');
  });

  it('invalidates when skipping a required Dashboard dependency (candidate null, missingRequiredIds populated)', () => {
    const ws = workspace({ queries: [panelQuery('p1', 'existing p1'), filterQuery('f1', 'existing f1')] });
    const decisions: QueryDecision[] = [
      { sourceId: 'p1', action: 'skip' }, { sourceId: 'f1', action: 'use-existing' },
    ];
    const plan = planImportDashboard(ws, buildBundle(), 'd1', decisions, 'copy', counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0].code).toBe('dashboard-import-invalid');
    expect(plan.diagnostics[0].message).toContain('p1');
  });

  it('reports a not-found diagnostic for an unknown sourceDashboardId', () => {
    const plan = planImportDashboard(workspace(), buildBundle(), 'missing', [], 'copy', counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.queryMappings).toEqual({});
    expect(plan.diagnostics).toEqual([
      { path: ['dashboards'], severity: 'error', code: 'import-dashboard-not-found', resource: 'missing', message: 'Bundle contains no dashboard with id "missing"' },
    ]);
    expect(plan.sourceDashboardId).toBe('missing');
  });

  it('returns candidateWorkspace: null with sorted diagnostics when the rewritten candidate still fails validation', () => {
    const ws = workspace();
    const badBundle = bundle({
      queries: [panelQuery('p1')],
      dashboards: [dashboardDoc({
        id: 'd1',
        tiles: [{ id: 't1', queryId: 'p1' }],
        // 'ghost' names no tile — layout-orphan-placement, unrelated to query mapping.
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, ghost: {} } },
      })],
    });
    const plan = planImportDashboard(ws, badBundle, 'd1', [], 'replace', counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics.some((d) => d.code === 'layout-orphan-placement')).toBe(true);
  });
});

// --- planReplaceWorkspace --------------------------------------------------------

describe('planReplaceWorkspace', () => {
  it('preserves workspace identity and replaces the query catalog wholesale (dropping unreferenced existing queries)', () => {
    const ws = workspace({
      id: 'w1', name: 'Mine', queries: [panelQuery('p1', 'existing p1'), panelQuery('old', 'unreferenced')],
    });
    const decisions: QueryDecision[] = [{ sourceId: 'p1', action: 'use-existing' }];
    const plan = planReplaceWorkspace(
      ws, bundle({ queries: [panelQuery('p1', 'bundle p1'), panelQuery('p2')] }), undefined, decisions, counter(),
    );
    const candidate = plan.candidateWorkspace!;
    expect(candidate.id).toBe('w1');
    expect(candidate.name).toBe('Mine');
    expect(ids(candidate.queries)).toEqual(['p1', 'p2']); // 'old' dropped
    expect(candidate.queries[0].spec.name).toBe('existing p1'); // use-existing kept existing content
    expect(candidate.dashboard).toBeNull();
    expect(plan.sourceDashboardId).toBeUndefined();
  });

  it('replaces queries AND Dashboard atomically when a source Dashboard is selected, including standalone queries', () => {
    const ws = workspace();
    // t1's query (p1) declares `{p:String}` — see `buildBundle`'s own comment
    // above for why a source-backed filter needs a valid consumer here.
    const bundleWithDashboard = bundle({
      queries: [
        { ...panelQuery('p1'), sql: 'SELECT {p:String}' }, filterQuery('f1'), panelQuery('standalone'),
      ],
      dashboards: [dashboardDoc({
        id: 'd1', revision: 2,
        tiles: [{ id: 't1', queryId: 'p1' }],
        filters: [{ id: 'flt1', parameter: 'p', sourceQueryId: 'f1' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      })],
    });
    const plan = planReplaceWorkspace(ws, bundleWithDashboard, 'd1', [], counter());
    const candidate = plan.candidateWorkspace!;
    expect(ids(candidate.queries)).toEqual(['p1', 'f1', 'standalone']);
    expect(candidate.dashboard!.id).toBe('d1');
    expect(candidate.dashboard!.revision).toBe(2);
    expect(plan.sourceDashboardId).toBe('d1');
  });

  it('reports a not-found diagnostic for an unknown sourceDashboardId', () => {
    const plan = planReplaceWorkspace(workspace(), bundle({ queries: [panelQuery('p1')] }), 'missing', [], counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics[0].code).toBe('import-dashboard-not-found');
  });

  it('invalidates when a required Dashboard dependency is skipped', () => {
    const ws = workspace({ queries: [panelQuery('p1', 'existing')] });
    const bundleWithDashboard = bundle({
      queries: [panelQuery('p1', 'incoming')],
      dashboards: [dashboardDoc({
        id: 'd1',
        tiles: [{ id: 't1', queryId: 'p1' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      })],
    });
    const decisions: QueryDecision[] = [{ sourceId: 'p1', action: 'skip' }];
    const plan = planReplaceWorkspace(ws, bundleWithDashboard, 'd1', decisions, counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics[0].code).toBe('dashboard-import-invalid');
    expect(plan.diagnostics[0].message).toContain('p1');
  });
});
