// #343 — read-before-write consistency across two browser tabs. Two real
// `createApp()` instances share ONE in-memory IndexedDB store (exactly as two
// tabs share the real database), so every Workbench/Dashboard mutation this
// step converted to a transform over `latest` (state.ts saved-query planners
// through `app.mutateWorkspace`) is exercised end-to-end: a change committed in
// tab A must survive an unrelated change committed in tab B, and an operation
// that no longer applies to `latest` must abort without recreating deleted data.
//
// These assert the persisted outcome via the active record's immutable ID, not
// UI refresh — the cross-tab invalidation/refresh wiring is #343 step 4+.

import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/ui/app.js';
import { createSavedQuery, commitSavedQuery, deleteSaved, renameSaved } from '../../src/state.js';
import { fakeIndexedDbFactory } from '../helpers/fake-idb.js';
import type { App } from '../../src/ui/app.types.js';
import type { SavedQueryV2, StoredWorkspaceV2, DashboardDocumentV1 } from '../../src/generated/json-schema.types.js';

// A minimal real `createApp` over an injected shared store — the editor/spec
// seams fall back to their noop ports (createApp's own defaults), so no
// CodeMirror is pulled in and construction never touches the DOM beyond `root`.
function tab(store: IDBFactory): App {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return createApp({ root, document, window, crypto: globalThis.crypto, indexedDB: store });
}

const tiledQuery = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT a, b', specVersion: 1,
  spec: { name: id, favorite: false, panel: { cfg: { type: 'bar', x: 0, y: [1] } } },
} as SavedQueryV2);

const twoTileDashboard = (): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'dash', title: 'D', revision: 1,
  layout: {
    type: 'flow', version: 1, preset: 'report',
    items: { t1: { span: 1, height: 'medium' }, t2: { span: 1, height: 'medium' } },
  },
  filters: [], tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
} as DashboardDocumentV1);

const dashboardSeed = (): StoredWorkspaceV2 => ({
  storageVersion: 2, id: 'w1', key: 'team', name: 'Team', queries: [tiledQuery('q1'), tiledQuery('q2')],
  dashboard: twoTileDashboard(),
});

/** Load the committed workspace from the shared store (fails loudly if empty). */
async function committed(app: App): Promise<StoredWorkspaceV2> {
  const loaded = await app.workspace.loadById(app.state.workspaceId);
  if (loaded.status !== 'ok') throw new Error('expected a committed workspace');
  return loaded.workspace;
}

const layoutItems = (workspace: StoredWorkspaceV2): Record<string, { span: number }> =>
  workspace.dashboard!.layout.items as Record<string, { span: number }>;
const queryById = (workspace: StoredWorkspaceV2, id: string): SavedQueryV2 | undefined =>
  workspace.queries.find((q) => q.id === id);

/** Seed the shared store (via A) and project it into both tabs, mirroring two
 *  tabs that each loaded the same committed aggregate on boot. */
async function seed(a: App, b: App, workspace: StoredWorkspaceV2): Promise<void> {
  const outcome = await a.workspace.create(workspace);
  expect(outcome.ok).toBe(true);
  if (outcome.ok) a.applyCommittedWorkspace(outcome.workspace);
  await b.loadWorkspaceOnBoot();
}

describe('cross-tab read-before-write (#343)', () => {
  it('Dashboard A resizes tile t1; Workbench B renames q1 — both survive', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, dashboardSeed());

    await a.mutateWorkspace((latest) => {
      const d = latest!.dashboard!;
      return { candidate: { ...latest!, dashboard: {
        ...d, revision: d.revision + 1,
        layout: { ...d.layout, items: { ...d.layout.items, t1: { span: 3, height: 'medium' } } },
      } } };
    });
    const renamed = await renameSaved(b.state, 'q1', 'Q1 renamed', undefined, b.mutateWorkspace);
    expect(renamed?.ok).toBe(true);

    const final = await committed(a);
    expect(layoutItems(final).t1.span).toBe(3); // A's resize survives B's write
    expect(queryById(final, 'q1')!.spec.name).toBe('Q1 renamed'); // and B's rename
  });

  it('Workbench A edits q1 SQL; Dashboard B moves t2 — both survive', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, dashboardSeed());

    // A saves an edit to the linked q1 (its projected Spec + a new SQL draft).
    const aTab = a.state.tabs.value[0];
    aTab.savedId = 'q1';
    aTab.sqlDraft = 'SELECT a, b, c';
    const q1Spec = a.state.savedQueries.find((q) => q.id === 'q1')!.spec;
    const edited = await commitSavedQuery(a.state, aTab, q1Spec, a.mutateWorkspace);
    expect(edited.ok).toBe(true);

    // B reorders the tiles (move t2 ahead of t1).
    await b.mutateWorkspace((latest) => {
      const d = latest!.dashboard!;
      return { candidate: { ...latest!, dashboard: { ...d, revision: d.revision + 1, tiles: [...d.tiles].reverse() } } };
    });

    const final = await committed(a);
    expect(queryById(final, 'q1')!.sql).toBe('SELECT a, b, c'); // A's SQL edit survives
    expect(final.dashboard!.tiles.map((t) => t.id)).toEqual(['t2', 't1']); // and B's move
  });

  it('Dashboard A removes a tile; Workbench B saves an unrelated query — the tile stays removed', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, dashboardSeed());

    await a.mutateWorkspace((latest) => {
      const d = latest!.dashboard!;
      const items = { ...d.layout.items };
      delete (items as Record<string, unknown>).t2;
      return { candidate: { ...latest!, dashboard: {
        ...d, revision: d.revision + 1, tiles: d.tiles.filter((t) => t.id !== 't2'), layout: { ...d.layout, items },
      } } };
    });

    const bTab = b.state.tabs.value[0];
    bTab.sqlDraft = 'SELECT unrelated';
    const created = await createSavedQuery(b.state, bTab, 'Unrelated', '', b.mutateWorkspace);
    expect(created.ok).toBe(true);

    const final = await committed(a);
    expect(final.dashboard!.tiles.map((t) => t.id)).toEqual(['t1']); // t2 stays removed
    expect(final.queries.some((q) => q.spec.name === 'Unrelated')).toBe(true); // B's save landed
  });

  it('Workbench A creates a query; Dashboard B changes layout — both survive', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, dashboardSeed());

    const aTab = a.state.tabs.value[0];
    aTab.sqlDraft = 'SELECT created';
    const created = await createSavedQuery(a.state, aTab, 'Fresh', '', a.mutateWorkspace);
    expect(created.ok).toBe(true);

    await b.mutateWorkspace((latest) => {
      const d = latest!.dashboard!;
      return { candidate: { ...latest!, dashboard: {
        ...d, revision: d.revision + 1,
        layout: { ...d.layout, items: { ...d.layout.items, t1: { span: 2, height: 'large' } } },
      } } };
    });

    const final = await committed(a);
    expect(final.queries.some((q) => q.spec.name === 'Fresh')).toBe(true); // A's new query survives
    expect(layoutItems(final).t1.span).toBe(2); // and B's layout change
  });

  it('save-linked to an externally deleted query aborts and does not recreate it', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    const seedNoDash: StoredWorkspaceV2 = {
      storageVersion: 2, id: 'w1', key: 'team', name: 'Team',
      queries: [{ id: 'q1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'q1', favorite: false } } as SavedQueryV2],
      dashboard: null,
    };
    await seed(a, b, seedNoDash);

    // B has an open tab linked to q1 with a local edit.
    const bTab = b.state.tabs.value[0];
    bTab.savedId = 'q1';
    bTab.sqlDraft = 'SELECT 1 -- edited in B';

    // A deletes q1 (no dashboard references it, so the delete commits).
    const deleted = await deleteSaved(a.state, 'q1', a.mutateWorkspace);
    expect(deleted.ok).toBe(true);

    // B now saves its linked tab — the target is gone from `latest`, so the
    // save aborts rather than recreating q1, and flags WHY so the caller can
    // refresh the tab association (#343 review).
    const result = await commitSavedQuery(b.state, bTab, { name: 'q1', favorite: false }, b.mutateWorkspace);
    expect(result).toEqual({ ok: false, entry: null, deletedExternally: true });

    const final = await committed(a);
    expect(final.queries.find((q) => q.id === 'q1')).toBeUndefined(); // never recreated
  });
});

// #343 steps 4/7/8 — the refresh + reconcile pipeline end-to-end across two
// tabs sharing one store: another tab reloads and projects the latest workspace,
// linked tabs adopt/conflict/detach/orphan, refresh coalesces + orders through
// the write queue, and a failed reload never wedges it.
describe('cross-tab refresh + linked-tab reconcile (#343)', () => {
  const oneQuery = (sql = 'SELECT 1', name = 'q1'): StoredWorkspaceV2 => ({
    storageVersion: 2, id: 'w1', key: 'team', name: 'Team',
    queries: [{ id: 'q1', sql, specVersion: 1, spec: { name, favorite: false } } as SavedQueryV2],
    dashboard: null,
  });
  /** Open q1 into a fresh linked tab on `app` (from its projected copy). */
  const openQ1 = (app: App): void => {
    app.actions.loadIntoNewTab({ ...app.state.savedQueries.find((q) => q.id === 'q1')! });
  };
  const linkedTab = (app: App) => app.state.tabs.value.find((t) => t.savedId === 'q1')!;

  it('another Workbench tab reloads and projects the latest committed workspace', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    await renameSaved(a.state, 'q1', 'Renamed in A', undefined, a.mutateWorkspace);
    // B still shows the old projection until it refreshes.
    expect(b.state.savedQueries.find((q) => q.id === 'q1')!.spec.name).toBe('q1');
    await b.refreshWorkspaceFromStore();
    expect(b.state.savedQueries.find((q) => q.id === 'q1')!.spec.name).toBe('Renamed in A');
  });

  it('a clean linked tab adopts an externally changed query without becoming dirty', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    openQ1(b);
    const bTab = linkedTab(b);
    expect(bTab.dirtySql).toBe(false);
    // A edits q1's SQL (a linked save).
    const aTab = a.state.tabs.value[0];
    aTab.savedId = 'q1';
    aTab.sqlDraft = 'SELECT 42';
    await commitSavedQuery(a.state, aTab, a.state.savedQueries[0].spec, a.mutateWorkspace);
    await b.refreshWorkspaceFromStore();
    expect(bTab.sqlDraft).toBe('SELECT 42'); // adopted
    expect(bTab.savedId).toBe('q1'); // still linked
    expect(bTab.dirtySql).toBe(false); // not dirty
    expect(bTab.externalState ?? null).toBeNull();
  });

  it('a flagged conflict survives a Library star/rename plus an unrelated external change (#343 review blocker)', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    const twoQueries: StoredWorkspaceV2 = {
      storageVersion: 2, id: 'w1', key: 'team', name: 'Team',
      queries: [
        { id: 'q1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'q1', favorite: false } } as SavedQueryV2,
        { id: 'q2', sql: 'SELECT 2', specVersion: 1, spec: { name: 'q2', favorite: false } } as SavedQueryV2,
      ],
      dashboard: null,
    };
    await seed(a, b, twoQueries);
    // B opens q1 and edits it (dirty draft).
    openQ1(b);
    const bTab = linkedTab(b);
    bTab.sqlDraft = 'SELECT my stale draft';
    bTab.dirtySql = true;
    // A changes q1; B refreshes → conflict (correctly flagged).
    await renameSaved(a.state, 'q1', 'Changed in A', undefined, a.mutateWorkspace);
    await b.refreshWorkspaceFromStore();
    expect(bTab.externalState).toBe('conflict');
    // B renames q1 from its own Library (metadata patch over LATEST — the same
    // path the star button uses). This must not resolve the conflict.
    const patched = await renameSaved(b.state, 'q1', 'Renamed in B too', undefined, b.mutateWorkspace);
    expect(patched?.ok).toBe(true);
    expect(bTab.externalState).toBe('conflict');
    // A then changes something UNRELATED (q2); B refreshes again.
    await renameSaved(a.state, 'q2', 'Unrelated change in A', undefined, a.mutateWorkspace);
    await b.refreshWorkspaceFromStore();
    // The stale dirty draft is still behind the resolver — never silently
    // saveable without Reload-saved-version / Keep-my-draft.
    expect(bTab.externalState).toBe('conflict');
    expect(bTab.sqlDraft).toBe('SELECT my stale draft');
    expect(bTab.dirtySql).toBe(true);
  });

  it('a star/rename on a CLEAN lagging tab adopts the external change immediately (#343 review blocker 2)', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    // B opens q1 clean.
    openQ1(b);
    const bTab = linkedTab(b);
    expect(bTab.dirtySql).toBe(false);
    // A changes q1's SQL; B does NOT refresh (missed poke).
    const aTab = a.state.tabs.value[0];
    aTab.savedId = 'q1';
    aTab.sqlDraft = 'SELECT 42 /* from A */';
    await commitSavedQuery(a.state, aTab, a.state.savedQueries[0].spec, a.mutateWorkspace);
    // B renames q1 from its Library. B's tab must contain A's latest SQL plus
    // B's metadata change immediately — NOT wait for a refresh that will no-op
    // (B's own commit just made its workspace token current).
    await renameSaved(b.state, 'q1', 'Renamed in B', undefined, b.mutateWorkspace);
    expect(bTab.sqlDraft).toBe('SELECT 42 /* from A */');
    expect(bTab.name).toBe('Renamed in B');
    expect(bTab.dirtySql).toBe(false);
    expect(bTab.externalState ?? null).toBeNull();
    // …and a refresh afterwards changes nothing (already consistent).
    await b.refreshWorkspaceFromStore();
    expect(bTab.sqlDraft).toBe('SELECT 42 /* from A */');
    expect(bTab.externalState ?? null).toBeNull();
    // The persisted workspace holds BOTH changes.
    const final = await committed(b);
    const q1 = final.queries.find((q) => q.id === 'q1')!;
    expect(q1.sql).toBe('SELECT 42 /* from A */');
    expect(q1.spec.name).toBe('Renamed in B');
  });

  it('a star/rename BEFORE any refresh cannot mask an unflagged external change (#343 review blocker)', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    openQ1(b);
    const bTab = linkedTab(b);
    bTab.sqlDraft = 'SELECT my stale draft';
    bTab.dirtySql = true;
    // A changes q1 — B misses the poke and does NOT refresh (no flag yet).
    await renameSaved(a.state, 'q1', 'Changed in A', undefined, a.mutateWorkspace);
    // B renames q1 immediately (folds into LATEST, including A's change) — the
    // stale tab's baseline token must NOT advance past A's unseen change.
    await renameSaved(b.state, 'q1', 'Renamed in B', undefined, b.mutateWorkspace);
    await b.refreshWorkspaceFromStore();
    expect(bTab.externalState).toBe('conflict'); // flagged, not silently in sync
    expect(bTab.sqlDraft).toBe('SELECT my stale draft');
  });

  it('a dirty linked tab preserves its draft and enters a conflict state', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    openQ1(b);
    const bTab = linkedTab(b);
    bTab.sqlDraft = 'SELECT my local draft';
    bTab.dirtySql = true;
    await renameSaved(a.state, 'q1', 'Changed in A', undefined, a.mutateWorkspace);
    await b.refreshWorkspaceFromStore();
    expect(bTab.sqlDraft).toBe('SELECT my local draft'); // draft preserved
    expect(bTab.dirtySql).toBe(true);
    expect(bTab.savedId).toBe('q1');
    expect(bTab.externalState).toBe('conflict');
  });

  it('an externally deleted clean tab detaches; a dirty one stays as an unsaved deleted-flagged draft', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    openQ1(b);
    const cleanTab = linkedTab(b);
    // A second tab on B, dirty-linked to q1.
    b.actions.loadIntoNewTab({ ...b.state.savedQueries[0], id: 'q1' });
    // Both b tabs link q1; make the FIRST clean, add a dirty second.
    b.actions.newTab();
    const dirty = b.state.tabs.value[b.state.tabs.value.length - 1];
    dirty.savedId = 'q1';
    dirty.sqlDraft = 'SELECT unsaved work';
    dirty.dirtySql = true;
    dirty.lastCommittedQueryToken = cleanTab.lastCommittedQueryToken;
    await deleteSaved(a.state, 'q1', a.mutateWorkspace);
    await b.refreshWorkspaceFromStore();
    expect(cleanTab.savedId).toBeNull(); // clean detaches
    expect(cleanTab.externalState ?? null).toBeNull();
    expect(dirty.savedId).toBeNull(); // dirty orphan — unlinked, not recreated
    expect(dirty.sqlDraft).toBe('SELECT unsaved work'); // draft intact
    expect(dirty.externalState).toBe('deleted');
  });

  it('is a no-op when the store is unchanged, and tolerates an externally cleared store', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    const before = b.state.savedQueries;
    await b.refreshWorkspaceFromStore(); // token unchanged → no reproject
    expect(b.state.savedQueries).toBe(before); // same reference, not reprojected
    await b.workspace.delete(b.state.workspaceId); // externally emptied
    await b.refreshWorkspaceFromStore(); // loaded === null → keeps projection
    expect(b.state.savedQueries).toBe(before);
  });

  it('coalesces duplicate invalidations into one store read', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    const spy = vi.spyOn(b.workspace, 'loadById');
    const poke = { type: 'workspace-changed' as const, sourceTabId: 'other', workspaceId: 'w1' };
    b.onExternalWorkspaceChange(poke);
    b.onExternalWorkspaceChange(poke);
    b.onExternalWorkspaceChange(poke);
    await b.flushWorkspaceWrites();
    expect(spy).toHaveBeenCalledTimes(1);
    void a;
  });

  it('a live read-only Dashboard tab refreshes from the primary workspace', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    // #407 view mode is a read-only projection of the same live workspace.
    await renameSaved(b.state, 'q1', 'Changed by B', undefined, b.mutateWorkspace);
    await a.refreshWorkspaceFromStore();
    expect(a.state.savedQueries[0].spec.name).toBe('Changed by B');
  });

  it('works without a BroadcastChannel (null factory): refresh still projects', async () => {
    const store = fakeIndexedDbFactory();
    const mk = (): App => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      return createApp({ root, document, window, crypto: globalThis.crypto, indexedDB: store, broadcastChannel: () => null });
    };
    const a = mk(); const b = mk();
    await seed(a, b, oneQuery());
    await renameSaved(a.state, 'q1', 'No-channel rename', undefined, a.mutateWorkspace);
    await b.refreshWorkspaceFromStore();
    expect(b.state.savedQueries[0].spec.name).toBe('No-channel rename');
  });

  it('a refresh queued behind a local write reflects both, and a rejected load does not wedge the queue', async () => {
    const store = fakeIndexedDbFactory();
    const a = tab(store); const b = tab(store);
    await seed(a, b, oneQuery());
    // A commits an external change; B is notified, then B starts its own write.
    await renameSaved(a.state, 'q1', 'A-rename', undefined, a.mutateWorkspace);
    b.onExternalWorkspaceChange({ type: 'workspace-changed', sourceTabId: 'other', workspaceId: 'w1' });
    const bTab = b.state.tabs.value[0];
    bTab.sqlDraft = 'SELECT b-created';
    const created = await createSavedQuery(b.state, bTab, 'B-new', '', b.mutateWorkspace);
    expect(created.ok).toBe(true);
    await b.flushWorkspaceWrites();
    const final = await committed(a);
    expect(final.queries.find((q) => q.id === 'q1')!.spec.name).toBe('A-rename'); // A's change survived
    expect(final.queries.some((q) => q.spec.name === 'B-new')).toBe(true); // B's write landed on refreshed latest

    // A rejected reload warns internally but never wedges: a later write succeeds.
    const orig = b.workspace.loadById.bind(b.workspace);
    b.workspace.loadById = vi.fn(async () => { throw new Error('idb down'); });
    await b.refreshWorkspaceFromStore(); // swallowed
    b.workspace.loadById = orig;
    const after = await b.mutateWorkspace((latest) => ({ candidate: { ...latest!, name: 'Recovered' } }));
    expect(after.ok).toBe(true);
  });
});
