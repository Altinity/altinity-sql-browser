import { describe, expect, it } from 'vitest';
import {
  autoResolveConflicts, buildQueryIdMapping, detectQueryConflicts, listBundleDashboards,
  planImportDashboard, planImportQueries, planReplaceWorkspace, rewriteDashboardReferences,
} from '../../src/workspace/import-planner.js';
import type {
  IdMapping, QueryConflict, QueryDecision,
} from '../../src/workspace/import-planner.js';
import type {
  DashboardDocumentV1, DashboardDocumentV2, PortableBundleV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../src/generated/json-schema.types.js';
import { buildDashboardExportBundle } from '../../src/dashboard/model/dashboard-export.js';
import { migrateStoredWorkspaceV3ToV5 } from '../../src/workspace/stored-workspace-ownership.js';
import { buildQueryOwnershipIndex } from '../../src/dashboard/model/query-ownership.js';

// --- fixtures ----------------------------------------------------------------

const panelQuery = (id: string, name = id): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { name, panel: { cfg: { type: 'bar', x: 0, y: [1] } } },
});

const setupQuery = (id: string, name = id): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { name, dashboard: { role: 'setup' } },
});

// Legacy Dashboard document v1 (curated filters) — used only to build the
// pre-migration StoredWorkspaceV3 fixture for the export round-trip below.
const dashboardDocV1 = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  filters: [], tiles: [], ...over,
});

// Current Dashboard document v2 (#447 — no curated filters).
const dashboardDoc = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
});

const workspace = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'Workspace', queries: [], dashboards: [], ...over,
});

const bundle = (over: Partial<PortableBundleV2> = {}): PortableBundleV2 => ({
  format: 'altinity-sql-browser/portable-bundle', version: 2,
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
      id: 'zeta', title: 'Zeta', tiles: [{ id: 't1', queryId: 'p1' }],
    });
    const alpha = dashboardDoc({ id: 'alpha', title: 'Alpha' });
    const summaries = listBundleDashboards(bundle({ dashboards: [zeta, alpha] }));
    expect(summaries).toEqual([
      { id: 'zeta', title: 'Zeta', tileCount: 1 },
      { id: 'alpha', title: 'Alpha', tileCount: 0 },
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

// #447: a panel tile is the only kind of Dashboard member left, so there is no
// filter.sourceQueryId reference to rewrite any more.
describe('rewriteDashboardReferences', () => {
  const dashboard = dashboardDoc({
    tiles: [{ id: 't1', queryId: 'p1' }],
    layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
  });

  it('rewrites tile.queryId via an IdMapping', () => {
    const mapping: IdMapping = { p1: { targetId: 'p1-copy', action: 'copy' } };
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(false);
    expect(result.missingRequiredIds).toEqual([]);
    expect(result.dashboard.tiles[0].queryId).toBe('p1-copy');
  });

  it('rewrites via a plain Map<string,string|null> too', () => {
    const mapping = new Map<string, string | null>([['p1', 'p2']]);
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(false);
    expect(result.dashboard.tiles[0].queryId).toBe('p2');
  });

  it('invalidates when a required reference maps to null (skipped)', () => {
    const mapping: IdMapping = { p1: { targetId: null, action: 'skip' } };
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(true);
    expect(result.missingRequiredIds).toEqual(['p1']);
    // Never silently dropped — the original reference is retained.
    expect(result.dashboard.tiles[0].queryId).toBe('p1');
  });

  it('invalidates when a required reference has no mapping entry at all (Map variant, too)', () => {
    const mapping = new Map<string, string | null>(); // p1 absent
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(true);
    expect(result.missingRequiredIds).toEqual(['p1']);
  });

  it('invalidates when a required reference has no IdMapping (Record) entry at all', () => {
    const mapping: IdMapping = {}; // p1 absent
    const result = rewriteDashboardReferences(dashboard, mapping);
    expect(result.invalidated).toBe(true);
    expect(result.missingRequiredIds).toEqual(['p1']);
  });

  it('never mutates the input dashboard (deep clone)', () => {
    const mapping: IdMapping = { p1: { targetId: 'p2', action: 'copy' } };
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

  // #427: an imported `spec.favorite` is a LIBRARY preference. It used to mint a
  // tile — and a whole compatibility Dashboard when the workspace had none — so
  // importing a queries-only bundle silently created Dashboard content. Now the
  // flag is preserved and nothing else moves.
  it('imports a favorite panel query into the Library, minting no tile and no Dashboard', () => {
    const ws = workspace({ queries: [panelQuery('a')], dashboards: [] });
    const favorite = panelQuery('b');
    favorite.spec.favorite = true;
    const plan = planImportQueries(ws, bundle({ queries: [favorite] }), [], counter());
    expect(plan.candidateWorkspace?.queries.find((query) => query.id === 'b')?.spec.favorite).toBe(true);
    expect(plan.candidateWorkspace?.dashboards).toEqual([]);
  });

  it('leaves an existing Dashboard byte-identical, revision included', () => {
    const dash = dashboardDoc({ revision: 7, tiles: [] });
    const ws = workspace({ queries: [panelQuery('a')], dashboards: [dash] });
    const favorite = panelQuery('b');
    favorite.spec.favorite = true;
    const plan = planImportQueries(ws, bundle({ queries: [favorite] }), [], counter());
    expect(plan.candidateWorkspace?.dashboards[0]?.tiles).toEqual([]);
    expect(plan.candidateWorkspace?.dashboards[0]?.revision).toBe(7);
  });

  it('does not remove a tile when a tiled query is replaced as unfavorited', () => {
    // The reverse direction is decoupled too: an import can no longer take a
    // panel off a Dashboard by clearing a flag. Removing a member is #429's
    // explicit action.
    const current = panelQuery('p1');
    current.spec.favorite = true;
    const replacement = panelQuery('p1', 'Replacement');
    replacement.spec.favorite = false;
    const dash = dashboardDoc({ revision: 7, tiles: [{ id: 't1', queryId: 'p1' }] });
    const plan = planImportQueries(
      workspace({ queries: [current], dashboards: [dash] }), bundle({ queries: [replacement] }),
      [{ sourceId: 'p1', action: 'replace' }], counter(),
    );
    expect(plan.candidateWorkspace?.dashboards[0]).toMatchObject({ revision: 7, tiles: [{ id: 't1', queryId: 'p1' }] });
    expect(plan.candidateWorkspace?.queries[0].spec.favorite).toBe(false);
  });

  it('never advances a Dashboard revision on a queries-only import', () => {
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

  it('keeps the tile when a tiled panel is replaced with a setup query, and diagnoses the role', () => {
    // #427: the import no longer silently removes the tile to make the role
    // change fit. The candidate is REJECTED with the role diagnostic instead, so
    // the reference and the Dashboard survive for an explicit repair.
    const current = panelQuery('p1');
    current.spec.favorite = true;
    const replacement = setupQuery('p1');
    replacement.spec.favorite = true;
    const dash = dashboardDoc({ revision: 7, tiles: [{ id: 't1', queryId: 'p1' }] });
    const plan = planImportQueries(
      workspace({ queries: [current], dashboards: [dash] }), bundle({ queries: [replacement] }),
      [{ sourceId: 'p1', action: 'replace' }], counter(),
    );
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics.some((d) => d.path.includes('tiles'))).toBe(true);
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
  // #447: this suite is about ID-rewriting through import — there is no filter
  // contract left to satisfy, so the bundled Dashboard carries only a tile.
  const buildBundle = () => bundle({
    queries: [panelQuery('p1', 'incoming p1')],
    dashboards: [dashboardDoc({
      id: 'd1', revision: 5,
      tiles: [{ id: 't1', queryId: 'p1' }],
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
    })],
  });

  it('rewrites tile.queryId, mints a fresh Dashboard id, and resets revision to 1', () => {
    const ws = workspace({ queries: [panelQuery('p1', 'existing p1')] });
    const decisions: QueryDecision[] = [
      { sourceId: 'p1', action: 'copy', targetId: 'p1-copy' },
    ];
    const genId = counter('new-dash');
    const plan = planImportDashboard(ws, buildBundle(), 'd1', decisions, genId);
    expect(plan.diagnostics).toEqual([]);
    const candidate = plan.candidateWorkspace!;
    expect(candidate.dashboards[0]!.id).toBe('new-dash-1');
    expect(candidate.dashboards[0]!.revision).toBe(1);
    // The decision resolves the reference to `p1-copy`; #427 then gives the
    // tile its OWN dedicated copy of that, which remains in the catalog as a
    // Library source.
    expect(candidate.dashboards[0]!.tiles[0].queryId).not.toBe('p1-copy');
    // existing catalog entries keep their position; the copy and the owned
    // copy are appended.
    expect(ids(candidate.queries).slice(0, 2)).toEqual(['p1', 'p1-copy']);
    expect(candidate.queries).toHaveLength(3);
    expect(plan.sourceDashboardId).toBe('d1');
  });

  // #463: the imported id is ALWAYS reminted, even when nothing collides. There
  // is no mode that keeps the bundle's own id, because an additive import that
  // did could seat two entries under one id by importing the same file twice.
  it('remints even a non-conflicting bundle Dashboard id', () => {
    const ws = workspace(); // no existing queries — the incoming id is non-conflicting
    const plan = planImportDashboard(ws, buildBundle(), 'd1', [], counter('fresh'));
    const candidate = plan.candidateWorkspace!;
    expect(candidate.dashboards[0]!.id).toBe('fresh-1');
    expect(candidate.dashboards[0]!.revision).toBe(1);
    // The bundle's own query survives as a Library source; the member owns a copy.
    expect(ids(candidate.queries).slice(0, 1)).toEqual(['p1']);
    expect(candidate.dashboards[0]!.tiles[0].queryId).not.toBe('p1');
    // Member ids are untouched, so #426's tree state survives an import.
    expect(candidate.dashboards[0]!.tiles[0].id).toBe('t1');
  });

  // Acceptance: importing is additive, so the same bundle twice is two
  // Dashboards — never a collision, never an overwrite.
  it('imports the same bundle twice as two distinct Dashboards', () => {
    const genId = counter('twice');
    const first = planImportDashboard(workspace(), buildBundle(), 'd1', [], genId);
    // The re-import's dependency is now canonically identical to the query the
    // first one seated, which is exactly what `autoResolveConflicts` decides for
    // the caller before this point.
    const second = planImportDashboard(
      first.candidateWorkspace!, buildBundle(), 'd1', [{ sourceId: 'p1', action: 'use-existing' }], genId,
    );
    const dashboards = second.candidateWorkspace!.dashboards;
    expect(dashboards).toHaveLength(2);
    expect(new Set(dashboards.map((d) => d.id)).size).toBe(2);
    expect(second.diagnostics).toEqual([]);
  });

  it('invalidates when skipping a required Dashboard dependency (candidate null, missingRequiredIds populated)', () => {
    const ws = workspace({ queries: [panelQuery('p1', 'existing p1')] });
    const decisions: QueryDecision[] = [{ sourceId: 'p1', action: 'skip' }];
    const plan = planImportDashboard(ws, buildBundle(), 'd1', decisions, counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0].code).toBe('dashboard-import-invalid');
    expect(plan.diagnostics[0].message).toContain('p1');
  });

  it('reports a not-found diagnostic for an unknown sourceDashboardId', () => {
    const plan = planImportDashboard(workspace(), buildBundle(), 'missing', [], counter());
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
    const plan = planImportDashboard(ws, badBundle, 'd1', [], counter());
    expect(plan.candidateWorkspace).toBeNull();
    expect(plan.diagnostics.some((d) => d.code === 'layout-orphan-placement')).toBe(true);
  });
});

// #424: an import that targets the workspace's VISIBLE Dashboard must not
// touch any other stored Dashboard. Every fixture above holds at most one, so
// these cover the collection explicitly.
describe('imports preserve the non-compatibility Dashboards', () => {
  const hidden = (): DashboardDocumentV2 => dashboardDoc({
    id: 'hidden', title: 'Hidden', revision: 12,
    tiles: [{ id: 'h1', queryId: 'a' }],
    layout: { type: 'flow', version: 1, preset: 'columns-2', items: { h1: {} } },
  });
  const twoDashboards = (compat: DashboardDocumentV2) =>
    workspace({ queries: [panelQuery('a')], dashboards: [compat, hidden()] });

  it('planImportQueries leaves every Dashboard alone when nothing is favorited', () => {
    const ws = twoDashboards(dashboardDoc({ revision: 4 }));
    const plan = planImportQueries(ws, bundle({ queries: [panelQuery('b')] }), [], counter());
    expect(plan.candidateWorkspace!.dashboards).toEqual(ws.dashboards);
  });

  it('planImportQueries leaves EVERY Dashboard untouched, compatibility slot included', () => {
    // #427: the imported favourite is a Library preference, so a queries-only
    // import is exactly that — a query-collection change and nothing else.
    const ws = twoDashboards(dashboardDoc({ revision: 4 }));
    const favorite = panelQuery('b');
    favorite.spec.favorite = true;
    const plan = planImportQueries(ws, bundle({ queries: [favorite] }), [], counter());
    const dashboards = plan.candidateWorkspace!.dashboards;
    expect(dashboards).toHaveLength(2);
    expect(dashboards[0]).toEqual(dashboardDoc({ revision: 4 }));
    expect(dashboards[1]).toEqual(hidden());
    expect(plan.candidateWorkspace!.queries.find((q) => q.id === 'b')?.spec.favorite).toBe(true);
  });

  // #463: the imported Dashboard is APPENDED. Both stored entries survive in
  // place, byte-for-byte, and neither the compatibility slot nor any other entry
  // is written.
  it('planImportDashboard appends after every stored Dashboard, replacing none', () => {
    const compat = dashboardDoc({ id: 'visible', revision: 4 });
    const ws = twoDashboards(compat);
    const incoming = bundle({
      queries: [panelQuery('a')],
      dashboards: [dashboardDoc({
        id: 'incoming', revision: 3, tiles: [{ id: 't1', queryId: 'a' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      })],
    });
    const plan = planImportDashboard(
      ws, incoming, 'incoming', [{ sourceId: 'a', action: 'use-existing' }], counter('new'),
    );
    const dashboards = plan.candidateWorkspace!.dashboards;
    // The imported document is LAST, under a freshly minted id…
    expect(dashboards.map((d) => d.id)).toEqual(['visible', 'hidden', 'new-1']);
    expect(dashboards[2].revision).toBe(1);
    // …and both stored Dashboards are untouched.
    expect(dashboards[0]).toEqual(compat);
    expect(dashboards[1]).toEqual(hidden());
  });

  // The defect #452 spent a whole target type defending against: a Dashboard
  // import must never write `dashboards[0]`. #463 makes it unrepresentable
  // rather than guarded, so this pins the outcome for the case that used to
  // reach the compatibility slot — no target named, non-empty collection.
  it('planImportDashboard never writes dashboards[0]', () => {
    const compat = dashboardDoc({ id: 'visible', revision: 4 });
    const ws = twoDashboards(compat);
    const plan = planImportDashboard(
      ws, bundle({ dashboards: [dashboardDoc({ id: 'incoming' })] }), 'incoming', [], counter('new'),
    );
    expect(plan.candidateWorkspace!.dashboards[0]).toEqual(compat);
  });

  // A bundle Dashboard whose id equals a STORED Dashboard's used to be a
  // duplicate-id diagnostic in replace mode. Appending remints, so the same
  // bundle now imports cleanly beside the entry it collided with.
  it('planImportDashboard remints past a bundle id that collides with a stored Dashboard', () => {
    const ws = twoDashboards(dashboardDoc({ id: 'visible' }));
    const incoming = bundle({
      queries: [panelQuery('a')],
      dashboards: [dashboardDoc({ id: 'hidden', title: 'Colliding' })],
    });
    const plan = planImportDashboard(
      ws, incoming, 'hidden', [{ sourceId: 'a', action: 'use-existing' }], counter('new'),
    );
    expect(plan.diagnostics).toEqual([]);
    const dashboards = plan.candidateWorkspace!.dashboards;
    expect(dashboards.map((d) => d.id)).toEqual(['visible', 'hidden', 'new-1']);
    expect(dashboards[2].title).toBe('Colliding');
    // The stored Dashboard that shared the bundle's id is byte-identical.
    expect(dashboards[1]).toEqual(hidden());
  });
});

// --- planReplaceWorkspace --------------------------------------------------------

// #427 — the round trip the app's own Dashboard export/import performs. This is
// the flow that regressed twice while implementing ownership, so it is pinned end
// to end: a REAL exported bundle, re-imported, must clone nothing and leave no
// junk behind. `buildDashboardExportBundle` ships only the dependency closure —
// the owned copy, never its Library source — so recognizing a copy cannot
// depend on its Library twin travelling with it.
describe('a Dashboard export round trip', () => {
  const migrated = (): StoredWorkspaceV5 => migrateStoredWorkspaceV3ToV5({
    storageVersion: 3, id: 'w', key: 'w', name: 'W',
    queries: [panelQuery('p1')],
    dashboards: [dashboardDocV1({
      id: 'd1', revision: 4,
      tiles: [{ id: 't1', queryId: 'p1' }],
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
    })],
  });

  it('re-imports an exported Dashboard without cloning anything again', () => {
    const source = migrated();
    const exported = buildDashboardExportBundle(
      source.dashboards[0], source.queries, '2026-07-25T00:00:00.000Z',
    );
    // The bundle carries ONLY the owned copy.
    expect(exported.queries.map((query) => query.id))
      .toEqual([source.dashboards[0].tiles[0].queryId]);

    const plan = planReplaceWorkspace(workspace(), exported, [], counter());
    const candidate = plan.candidateWorkspace!;
    expect(plan.diagnostics).toEqual([]);
    // One query in, one query out — no second generation of copies, and no
    // orphaned Library entries with duplicate names.
    expect(candidate.queries.map((query) => query.id)).toEqual(exported.queries.map((query) => query.id));
    expect(candidate.dashboards[0].tiles[0].queryId).toBe(source.dashboards[0].tiles[0].queryId);
    // The copy still has exactly its one owner, and nothing is in the Library.
    const index = buildQueryOwnershipIndex(candidate);
    expect(index.libraryQueryIds.size).toBe(0);
    for (const owners of index.ownersByQueryId.values()) expect(owners).toHaveLength(1);
  });

  it('is stable across a second round trip', () => {
    const source = migrated();
    const once = planReplaceWorkspace(
      workspace(), buildDashboardExportBundle(source.dashboards[0], source.queries, '2026-07-25T00:00:00.000Z'),
      [], counter(),
    ).candidateWorkspace!;
    const twice = planReplaceWorkspace(
      workspace(), buildDashboardExportBundle(once.dashboards[0], once.queries, '2026-07-25T00:00:00.000Z'),
      [], counter(),
    ).candidateWorkspace!;
    expect(twice.queries.map((query) => query.id)).toEqual(once.queries.map((query) => query.id));
  });
});

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

  it('creates NO Dashboard for favorite panel queries in a query-only workspace import', () => {
    // #427: a queries-only bundle used to mint a whole compatibility Dashboard
    // out of favourite flags. A favourite is a Library preference now, so a
    // bundle with no dashboards produces a workspace with no dashboards.
    const favorite = panelQuery('p1');
    favorite.spec.favorite = true;
    const plan = planReplaceWorkspace(workspace(), bundle({ queries: [favorite] }), [], counter());
    expect(plan.candidateWorkspace?.dashboards).toEqual([]);
    expect(plan.candidateWorkspace?.queries[0].spec.favorite).toBe(true);
  });

  it('replaces queries AND every bundled Dashboard atomically, including standalone queries', () => {
    const ws = workspace();
    const bundleWithDashboard = bundle({
      queries: [panelQuery('p1'), panelQuery('standalone')],
      dashboards: [dashboardDoc({
        id: 'd1', revision: 2,
        tiles: [{ id: 't1', queryId: 'p1' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      })],
    });
    const plan = planReplaceWorkspace(ws, bundleWithDashboard, [], counter());
    const candidate = plan.candidateWorkspace!;
    // #427: the bundle's own query survives as a Library source, and the tile
    // gains a DEDICATED copy with a derived id. The Dashboard keeps its id,
    // revision and member ids.
    expect(ids(candidate.queries).slice(0, 2)).toEqual(['p1', 'standalone']);
    expect(candidate.queries).toHaveLength(3);
    expect(candidate.dashboards[0]!.tiles[0].queryId).not.toBe('p1');
    expect(candidate.dashboards[0]!.tiles[0].id).toBe('t1');
    expect(candidate.dashboards[0]!.id).toBe('d1');
    expect(candidate.dashboards[0]!.revision).toBe(2);
    // A workspace import no longer selects ONE Dashboard, so it reports none.
    expect(plan.sourceDashboardId).toBeUndefined();
  });

  // #424: a workspace import takes the bundle WHOLE — every Dashboard, in
  // bundle order — instead of collapsing a multi-Dashboard bundle to one.
  it('imports EVERY bundled Dashboard, preserving bundle order and per-Dashboard ids', () => {
    const bundleWithTwo = bundle({
      queries: [panelQuery('p1')],
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
    // #427: a legacy bundle sharing ONE query between two Dashboards is
    // NORMALIZED rather than rejected — the bundle query stays as the Library
    // source and each tile gets its own dedicated copy.
    expect(ids(candidate.queries)[0]).toBe('p1');
    expect(candidate.queries).toHaveLength(3);
    const [exec, sales] = candidate.dashboards;
    expect(exec.tiles[0].queryId).not.toBe(sales.tiles[0].queryId);
    expect(exec.tiles[0].queryId).not.toBe('p1');
    expect(exec.tiles[0].id).toBe('exec-p1');
    expect(plan.sourceDashboardId).toBeUndefined();
  });

  it('applies query-id remaps inside EVERY imported Dashboard', () => {
    const ws = workspace({ queries: [panelQuery('p1', 'existing')] });
    const bundleWithTwo = bundle({
      queries: [panelQuery('p1', 'incoming')],
      dashboards: [
        dashboardDoc({ id: 'a', tiles: [{ id: 'ta', queryId: 'p1' }], layout: { type: 'flow', version: 1, preset: 'report', items: { ta: {} } } }),
        dashboardDoc({ id: 'b', tiles: [{ id: 'tb', queryId: 'p1' }], layout: { type: 'flow', version: 1, preset: 'report', items: { tb: {} } } }),
      ],
    });
    const decisions: QueryDecision[] = [{ sourceId: 'p1', action: 'copy', targetId: 'p1-copy' }];
    const candidate = planReplaceWorkspace(ws, bundleWithTwo, decisions, counter()).candidateWorkspace!;
    // The remap resolves both references to `p1-copy` first; #427's normalization
    // then gives each tile its own dedicated copy OF that remapped query, which
    // survives as the Library source. Two members, two distinct owned ids.
    const owned = candidate.dashboards.map((d) => d.tiles[0].queryId);
    expect(new Set(owned).size).toBe(2);
    expect(owned).not.toContain('p1-copy');
    expect(ids(candidate.queries)).toContain('p1-copy');
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
    const favorite = panelQuery('p1');
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
