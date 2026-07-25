import { describe, expect, it } from 'vitest';
import {
  autoResolveConflicts, buildQueryIdMapping, detectQueryConflicts, listBundleDashboards,
  planImportDashboard, planImportQueries, planReplaceWorkspace, rewriteDashboardReferences,
} from '../../src/workspace/import-planner.js';
import type {
  IdMapping, QueryConflict, QueryDecision,
} from '../../src/workspace/import-planner.js';
import type {
  DashboardDocumentV1, PortableBundleV1, SavedQueryV2, StoredWorkspaceV3,
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

const setupQuery = (id: string, name = id): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { name, dashboard: { role: 'setup' } },
});

const dashboardDoc = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  filters: [], tiles: [], ...over,
});

const workspace = (over: Partial<StoredWorkspaceV3> = {}): StoredWorkspaceV3 => ({
  storageVersion: 3, id: 'w1', key: 'workspace', name: 'Workspace', queries: [], dashboards: [], ...over,
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
    const ws = workspace({ queries: [panelQuery('a')], dashboards: [dash] });
    const plan = planImportQueries(ws, bundle({ queries: [panelQuery('b')] }), [], counter());
    expect(plan.candidateWorkspace).not.toBeNull();
    expect(ids(plan.candidateWorkspace!.queries)).toEqual(['a', 'b']);
    expect(plan.candidateWorkspace!.dashboards[0]).toBe(dash);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.sourceDashboardId).toBeUndefined();
  });

  it('imports a favorite panel query as a Dashboard tile', () => {
    const ws = workspace({ queries: [panelQuery('a')], dashboards: [] });
    const favorite = panelQuery('b');
    favorite.spec.favorite = true;
    const plan = planImportQueries(ws, bundle({ queries: [favorite] }), [], counter());
    expect(plan.candidateWorkspace?.queries.find((query) => query.id === 'b')?.spec.favorite).toBe(true);
    expect(plan.candidateWorkspace?.dashboards[0]).toMatchObject({
      title: 'Dashboard', tiles: [{ queryId: 'b' }],
    });
  });

  it('adds one favorite panel query to an existing Dashboard and increments its revision once', () => {
    const dash = dashboardDoc({ revision: 7, tiles: [] });
    const ws = workspace({ queries: [panelQuery('a')], dashboards: [dash] });
    const favorite = panelQuery('b');
    favorite.spec.favorite = true;
    const plan = planImportQueries(ws, bundle({ queries: [favorite] }), [], counter());
    expect(plan.candidateWorkspace?.dashboards[0]?.tiles).toEqual([{ id: 'id-1', queryId: 'b' }]);
    expect(plan.candidateWorkspace?.dashboards[0]?.revision).toBe(8);
  });

  it('adds several favorite panel queries but increments an existing Dashboard revision only once', () => {
    const dash = dashboardDoc({ revision: 7, tiles: [] });
    const one = panelQuery('one');
    const two = panelQuery('two');
    one.spec.favorite = true;
    two.spec.favorite = true;
    const plan = planImportQueries(workspace({ dashboards: [dash] }), bundle({ queries: [one, two] }), [], counter());
    expect(plan.candidateWorkspace?.dashboards[0]?.tiles).toEqual([
      { id: 'id-1', queryId: 'one' }, { id: 'id-2', queryId: 'two' },
    ]);
    expect(plan.candidateWorkspace?.dashboards[0]?.revision).toBe(8);
  });

  it('does not advance revision when an imported favorite already has Dashboard membership', () => {
    const favorite = panelQuery('p1');
    favorite.spec.favorite = true;
    const dash = dashboardDoc({ revision: 7, tiles: [{ id: 't1', queryId: 'p1' }] });
    const decisions: QueryDecision[] = [{ sourceId: 'p1', action: 'replace' }];
    const plan = planImportQueries(workspace({ queries: [favorite], dashboards: [dash] }), bundle({ queries: [favorite] }), decisions, counter());
    expect(plan.candidateWorkspace?.dashboards[0]).toBe(dash);
    expect(plan.candidateWorkspace?.dashboards[0]?.revision).toBe(7);
  });

  it('overwrites the existing entry in place on a replace decision', () => {
    const ws = workspace({ queries: [panelQuery('a', 'old name')] });
    const decisions: QueryDecision[] = [{ sourceId: 'a', action: 'replace' }];
    const plan = planImportQueries(ws, bundle({ queries: [panelQuery('a', 'new name')] }), decisions, counter());
    expect(ids(plan.candidateWorkspace!.queries)).toEqual(['a']);
    expect(plan.candidateWorkspace!.queries[0].spec.name).toBe('new name');
  });

  it('removes tile membership and increments revision when a tiled favorite is replaced as unfavorited', () => {
    const current = panelQuery('p1');
    current.spec.favorite = true;
    const replacement = panelQuery('p1', 'Replacement');
    replacement.spec.favorite = false;
    const dash = dashboardDoc({ revision: 7, tiles: [{ id: 't1', queryId: 'p1' }] });
    const plan = planImportQueries(
      workspace({ queries: [current], dashboards: [dash] }), bundle({ queries: [replacement] }),
      [{ sourceId: 'p1', action: 'replace' }], counter(),
    );
    expect(plan.candidateWorkspace?.dashboards[0]).toMatchObject({ revision: 8, tiles: [] });
    expect(plan.candidateWorkspace?.queries[0].spec.favorite).toBe(false);
  });

  it.each([
    ['filter', filterQuery('p1')],
    ['setup', setupQuery('p1')],
  ])('removes tile membership when a tiled panel is replaced with a %s query', (_role, replacement) => {
    const current = panelQuery('p1');
    current.spec.favorite = true;
    replacement.spec.favorite = true;
    const dash = dashboardDoc({ revision: 7, tiles: [{ id: 't1', queryId: 'p1' }] });
    const plan = planImportQueries(
      workspace({ queries: [current], dashboards: [dash] }), bundle({ queries: [replacement] }),
      [{ sourceId: 'p1', action: 'replace' }], counter(),
    );
    expect(plan.candidateWorkspace?.dashboards[0]).toMatchObject({ revision: 8, tiles: [] });
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
    expect(candidate.dashboards[0]!.id).toBe('new-dash-1');
    expect(candidate.dashboards[0]!.revision).toBe(1);
    expect(candidate.dashboards[0]!.tiles[0].queryId).toBe('p1-copy');
    expect(candidate.dashboards[0]!.filters[0].sourceQueryId).toBe('f1-copy');
    // existing catalog entries keep their position; new copies are appended.
    expect(ids(candidate.queries)).toEqual(['p1', 'f1', 'p1-copy', 'f1-copy']);
    expect(plan.sourceDashboardId).toBe('d1');
  });

  it('replace mode keeps the imported Dashboard id and revision', () => {
    const ws = workspace(); // no existing queries — both incoming ids are non-conflicting
    const plan = planImportDashboard(ws, buildBundle(), 'd1', [], 'replace', counter());
    const candidate = plan.candidateWorkspace!;
    expect(candidate.dashboards[0]!.id).toBe('d1');
    expect(candidate.dashboards[0]!.revision).toBe(5);
    expect(candidate.dashboards[0]!.tiles[0].queryId).toBe('p1');
    expect(candidate.dashboards[0]!.filters[0].sourceQueryId).toBe('f1');
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

// #424: an import that targets the workspace's VISIBLE Dashboard must not
// touch any other stored Dashboard. Every fixture above holds at most one, so
// these cover the collection explicitly.
describe('imports preserve the non-compatibility Dashboards', () => {
  const hidden = (): DashboardDocumentV1 => dashboardDoc({
    id: 'hidden', title: 'Hidden', revision: 12,
    tiles: [{ id: 'h1', queryId: 'a' }],
    layout: { type: 'flow', version: 1, preset: 'columns-2', items: { h1: {} } },
  });
  const twoDashboards = (compat: DashboardDocumentV1) =>
    workspace({ queries: [panelQuery('a')], dashboards: [compat, hidden()] });

  it('planImportQueries leaves every Dashboard alone when nothing is favorited', () => {
    const ws = twoDashboards(dashboardDoc({ revision: 4 }));
    const plan = planImportQueries(ws, bundle({ queries: [panelQuery('b')] }), [], counter());
    expect(plan.candidateWorkspace!.dashboards).toEqual(ws.dashboards);
  });

  it('planImportQueries adds an imported favorite to the compatibility Dashboard only', () => {
    const ws = twoDashboards(dashboardDoc({ revision: 4 }));
    const favorite = panelQuery('b');
    favorite.spec.favorite = true;
    const plan = planImportQueries(ws, bundle({ queries: [favorite] }), [], counter());
    const dashboards = plan.candidateWorkspace!.dashboards;
    expect(dashboards).toHaveLength(2);
    expect(dashboards[0].tiles).toEqual([{ id: 'id-1', queryId: 'b' }]);
    expect(dashboards[0].revision).toBe(5);
    expect(dashboards[1]).toEqual(hidden());
  });

  it('planImportDashboard replaces the compatibility slot and preserves the rest', () => {
    const ws = twoDashboards(dashboardDoc({ id: 'visible', revision: 4 }));
    const incoming = bundle({
      queries: [panelQuery('a')],
      dashboards: [dashboardDoc({
        id: 'incoming', revision: 3, tiles: [{ id: 't1', queryId: 'a' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      })],
    });
    const plan = planImportDashboard(
      ws, incoming, 'incoming', [{ sourceId: 'a', action: 'use-existing' }], 'copy', counter('new'),
    );
    const dashboards = plan.candidateWorkspace!.dashboards;
    // The imported document took slot 0 under a freshly minted id…
    expect(dashboards.map((d) => d.id)).toEqual(['new-1', 'hidden']);
    expect(dashboards[0].revision).toBe(1);
    // …and the workspace's other Dashboard is untouched.
    expect(dashboards[1]).toEqual(hidden());
  });

  // #425: an import invoked from a Dashboard's own File menu must replace THAT
  // Dashboard. Addressing the compatibility slot would import "into" a Dashboard
  // the user is not looking at, once a non-first one can be open.
  it('planImportDashboard replaces the TARGET Dashboard by id, preserving the first', () => {
    const ws = twoDashboards(dashboardDoc({ id: 'visible', revision: 4 }));
    const incoming = bundle({
      queries: [panelQuery('a')],
      dashboards: [dashboardDoc({
        id: 'incoming', revision: 3, tiles: [{ id: 't1', queryId: 'a' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      })],
    });
    const plan = planImportDashboard(
      ws, incoming, 'incoming', [{ sourceId: 'a', action: 'use-existing' }], 'copy', counter('new'),
      {}, 'hidden',
    );
    const dashboards = plan.candidateWorkspace!.dashboards;
    expect(dashboards.map((d) => d.id)).toEqual(['visible', 'new-1']);
    // The first entry is byte-identical; only the addressed one was replaced.
    expect(dashboards[0]).toEqual(dashboardDoc({ id: 'visible', revision: 4 }));
  });

  it('planImportDashboard falls back to the compatibility slot for an unknown target', () => {
    const ws = twoDashboards(dashboardDoc({ id: 'visible', revision: 4 }));
    const incoming = bundle({
      queries: [panelQuery('a')],
      dashboards: [dashboardDoc({ id: 'incoming' })],
    });
    // Deleted concurrently: the import still lands rather than being dropped.
    const plan = planImportDashboard(
      ws, incoming, 'incoming', [{ sourceId: 'a', action: 'use-existing' }], 'copy', counter('new'),
      {}, 'gone',
    );
    expect(plan.candidateWorkspace!.dashboards.map((d) => d.id)).toEqual(['new-1', 'hidden']);
  });

  it('planImportDashboard diagnoses a replace-mode id that collides with a hidden Dashboard', () => {
    const ws = twoDashboards(dashboardDoc({ id: 'visible' }));
    const incoming = bundle({
      queries: [panelQuery('a')],
      // Same id as the workspace's HIDDEN Dashboard — taking the compatibility
      // slot under it would leave two entries sharing one id.
      dashboards: [dashboardDoc({ id: 'hidden', title: 'Colliding' })],
    });
    const plan = planImportDashboard(
      ws, incoming, 'hidden', [{ sourceId: 'a', action: 'use-existing' }], 'replace', counter(),
    );
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics.some((d) => d.code === 'workspace-duplicate-dashboard-id')).toBe(true);
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
      ws, bundle({ queries: [panelQuery('p1', 'bundle p1'), panelQuery('p2')] }), decisions, counter(),
    );
    const candidate = plan.candidateWorkspace!;
    expect(candidate.id).toBe('w1');
    expect(candidate.name).toBe('Mine');
    expect(ids(candidate.queries)).toEqual(['p1', 'p2']); // 'old' dropped
    expect(candidate.queries[0].spec.name).toBe('existing p1'); // use-existing kept existing content
    expect(candidate.dashboards).toEqual([]);
    expect(plan.sourceDashboardId).toBeUndefined();
  });

  it('creates Dashboard membership for favorite panel queries in a query-only workspace import', () => {
    const favorite = panelQuery('p1');
    favorite.spec.favorite = true;
    const plan = planReplaceWorkspace(workspace(), bundle({ queries: [favorite] }), [], counter());
    expect(plan.candidateWorkspace?.dashboards[0]).toMatchObject({
      title: 'Dashboard', tiles: [{ queryId: 'p1' }],
    });
  });

  it('replaces queries AND every bundled Dashboard atomically, including standalone queries', () => {
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
    const plan = planReplaceWorkspace(ws, bundleWithDashboard, [], counter());
    const candidate = plan.candidateWorkspace!;
    expect(ids(candidate.queries)).toEqual(['p1', 'f1', 'standalone']);
    expect(candidate.dashboards[0]!.id).toBe('d1');
    expect(candidate.dashboards[0]!.revision).toBe(2);
    // A workspace import no longer selects ONE Dashboard, so it reports none.
    expect(plan.sourceDashboardId).toBeUndefined();
  });

  // #424: a workspace import takes the bundle WHOLE — every Dashboard, in
  // bundle order — instead of collapsing a multi-Dashboard bundle to one.
  it('imports EVERY bundled Dashboard, preserving bundle order and per-Dashboard ids', () => {
    const bundleWithTwo = bundle({
      queries: [{ ...panelQuery('p1'), sql: 'SELECT {p:String}' }],
      dashboards: [
        dashboardDoc({
          id: 'exec', title: 'Executive', revision: 3,
          tiles: [{ id: 'exec-p1', queryId: 'p1' }],
          layout: { type: 'flow', version: 1, preset: 'report', items: { 'exec-p1': {} } },
        }),
        dashboardDoc({
          id: 'sales', title: 'Sales', revision: 9,
          tiles: [{ id: 'sales-p1', queryId: 'p1' }],
          layout: { type: 'flow', version: 1, preset: 'columns-2', items: { 'sales-p1': {} } },
        }),
      ],
    });
    const plan = planReplaceWorkspace(workspace(), bundleWithTwo, [], counter());
    const candidate = plan.candidateWorkspace!;
    expect(candidate.dashboards.map((d) => d.id)).toEqual(['exec', 'sales']);
    expect(candidate.dashboards.map((d) => d.revision)).toEqual([3, 9]);
    // One shared query referenced by both Dashboards is still stored ONCE.
    expect(ids(candidate.queries)).toEqual(['p1']);
    expect(plan.sourceDashboardId).toBeUndefined();
  });

  it('applies query-id remaps inside EVERY imported Dashboard', () => {
    const ws = workspace({ queries: [{ ...panelQuery('p1', 'existing'), sql: 'SELECT {p:String}' }] });
    const bundleWithTwo = bundle({
      queries: [{ ...panelQuery('p1', 'incoming'), sql: 'SELECT {p:String}' }],
      dashboards: [
        dashboardDoc({ id: 'a', tiles: [{ id: 'ta', queryId: 'p1' }], layout: { type: 'flow', version: 1, preset: 'report', items: { ta: {} } } }),
        dashboardDoc({ id: 'b', tiles: [{ id: 'tb', queryId: 'p1' }], layout: { type: 'flow', version: 1, preset: 'report', items: { tb: {} } } }),
      ],
    });
    const decisions: QueryDecision[] = [{ sourceId: 'p1', action: 'copy', targetId: 'p1-copy' }];
    const candidate = planReplaceWorkspace(ws, bundleWithTwo, decisions, counter()).candidateWorkspace!;
    expect(candidate.dashboards.map((d) => d.tiles[0].queryId)).toEqual(['p1-copy', 'p1-copy']);
  });

  it('diagnoses duplicate incoming Dashboard ids rather than silently deduplicating', () => {
    const dup = bundle({
      dashboards: [dashboardDoc({ id: 'same' }), dashboardDoc({ id: 'same', title: 'Other' })],
    });
    const plan = planReplaceWorkspace(workspace(), dup, [], counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics.some((d) => d.code === 'workspace-duplicate-dashboard-id')).toBe(true);
  });

  it('does not derive favorite tiles when the bundle carries its own Dashboards', () => {
    const favorite = { ...panelQuery('p1'), sql: 'SELECT {p:String}' };
    favorite.spec.favorite = true;
    const plan = planReplaceWorkspace(workspace(), bundle({
      queries: [favorite],
      dashboards: [dashboardDoc({ id: 'only', tiles: [], layout: { type: 'flow', version: 1, preset: 'report', items: {} } })],
    }), [], counter());
    const candidate = plan.candidateWorkspace!;
    expect(candidate.dashboards.map((d) => d.id)).toEqual(['only']);
    expect(candidate.dashboards[0].tiles).toEqual([]);
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
    const plan = planReplaceWorkspace(ws, bundleWithDashboard, decisions, counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics[0].code).toBe('dashboard-import-invalid');
    expect(plan.diagnostics[0].message).toContain('p1');
    // #424: the diagnostic names WHICH bundled Dashboard broke the plan.
    expect(plan.diagnostics[0].path).toEqual(['dashboards', 0]);
  });
});
