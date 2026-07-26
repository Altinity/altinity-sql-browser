import { describe, it, expect } from 'vitest';
import {
  fileMenuModel, fileMenuFooter,
} from '../../src/core/file-menu-model.js';
import type {
  FileMenuActionId, FileMenuContext, FileMenuItemSpec, FileMenuSurface,
} from '../../src/core/file-menu-model.js';

// The settled row order (#452). Every assertion about "the same menu everywhere"
// compares against this one list, so a reordering breaks every surface's spec at
// once rather than silently passing on the surface nobody re-fixtured.
const ORDER: FileMenuActionId[] = [
  'new-workspace', 'import-workspace', 'export-workspace',
  'import-queries', 'import-dashboard', 'export-dashboard',
  'download-md', 'download-sql',
];

const LABELS = [
  'New workspace…', 'Import workspace…', 'Export workspace…',
  'Import queries…', 'Import Dashboard…', 'Export Dashboard…',
  'Download Library as Markdown', 'Download Library as SQL',
];

const QUERY: FileMenuSurface = { surface: 'query' };
const edit = (dashboardId: string | null): FileMenuSurface =>
  ({ surface: 'dashboard', mode: 'edit', dashboardId });
const view = (dashboardId: string | null): FileMenuSurface =>
  ({ surface: 'dashboard', mode: 'view', dashboardId });

const ctx = (over: Partial<FileMenuContext> = {}): FileMenuContext => ({
  surface: QUERY, hasWorkspace: true, libraryQueryCount: 3, dashboardCount: 1, ...over,
});

const byId = (c: FileMenuContext, id: FileMenuActionId): FileMenuItemSpec =>
  fileMenuModel(c).items.find((item) => item.id === id)!;
/** `[enabled, reason]` — the pair every availability rule is asserted as, so a
 *  row can never be checked for one without the other. */
const state = (c: FileMenuContext, id: FileMenuActionId): [boolean, string | null] => {
  const item = byId(c, id);
  return [item.enabled, item.reason];
};

// Every surface the application can render a File menu on (#452's Goal list).
const SURFACES: [name: string, surface: FileMenuSurface][] = [
  ['Query', QUERY],
  ['Dashboard Edit', edit('d1')],
  ['Dashboard View', view('d1')],
  ['empty Dashboard placeholder', edit(null)],
];

describe('fileMenuModel — one stable structure on every surface', () => {
  // Issue test 1: Query, Dashboard Edit, Dashboard View and the empty Dashboard
  // render the same labels in the same order.
  it.each(SURFACES)('%s renders all eight rows, same ids, same labels, same order', (_name, surface) => {
    const model = fileMenuModel(ctx({ surface }));
    expect(model.items.map((item) => item.id)).toEqual(ORDER);
    expect(model.items.map((item) => item.label)).toEqual(LABELS);
  });

  // Issue acceptance: "Context changes enabled state only; rows never disappear
  // or move." Asserted across the whole cartesian product rather than per case,
  // so a future rule that filters instead of disabling cannot slip through.
  it('never adds, removes, reorders or relabels a row for ANY context', () => {
    const surfaces = [QUERY, edit('d1'), view('d1'), edit(null), view(null)];
    for (const surface of surfaces) {
      for (const hasWorkspace of [true, false]) {
        for (const libraryQueryCount of [0, 1, 7]) {
          for (const dashboardCount of [0, 1, 4]) {
            const model = fileMenuModel({ surface, hasWorkspace, libraryQueryCount, dashboardCount });
            expect(model.items.map((item) => item.id)).toEqual(ORDER);
            expect(model.items.map((item) => item.label)).toEqual(LABELS);
          }
        }
      }
    }
  });

  it('groups the two Library downloads behind the one divider', () => {
    const model = fileMenuModel(ctx());
    expect(model.items.filter((item) => item.separatorBefore).map((item) => item.id))
      .toEqual(['download-md']);
  });

  it('keeps the file extension on a row independent of its availability', () => {
    expect(byId(ctx(), 'export-workspace').meta).toBe('.json');
    expect(byId(ctx(), 'export-dashboard').meta).toBe('.json');
    expect(byId(ctx(), 'download-md').meta).toBe('.md');
    expect(byId(ctx(), 'download-sql').meta).toBe('.sql');
    expect(byId(ctx(), 'new-workspace').meta).toBeNull();
    // Disabled rows keep their extension AND carry a reason.
    const disabled = byId(ctx({ libraryQueryCount: 0 }), 'download-md');
    expect(disabled).toMatchObject({ meta: '.md', enabled: false, reason: 'No Library queries' });
  });

  it('reports a reason exactly when a row is disabled', () => {
    for (const surface of [QUERY, edit('d1'), view('d1'), edit(null)]) {
      for (const item of fileMenuModel(ctx({ surface, hasWorkspace: false, libraryQueryCount: 0 })).items) {
        expect(item.enabled).toBe(item.reason === null);
      }
    }
  });
});

describe('fileMenuModel — workspace operations', () => {
  it('New workspace and Import workspace need nothing at all', () => {
    const nothing = ctx({ surface: view(null), hasWorkspace: false, libraryQueryCount: 0, dashboardCount: 0 });
    expect(state(nothing, 'new-workspace')).toEqual([true, null]);
    expect(state(nothing, 'import-workspace')).toEqual([true, null]);
  });

  // Issue test 7: no active workspace disables what requires one — without
  // changing row order (covered by the invariant test above).
  it('Export workspace requires a resolved workspace', () => {
    expect(state(ctx({ hasWorkspace: true }), 'export-workspace')).toEqual([true, null]);
    expect(state(ctx({ hasWorkspace: false }), 'export-workspace')).toEqual([false, 'No workspace']);
  });

  it('workspace operations do not depend on Query versus Dashboard', () => {
    for (const surface of [QUERY, edit('d1'), view('d1'), edit(null)]) {
      expect(state(ctx({ surface }), 'export-workspace')).toEqual([true, null]);
      expect(state(ctx({ surface }), 'new-workspace')).toEqual([true, null]);
    }
  });
});

describe('fileMenuModel — Library operations', () => {
  // Issue test 5: Dashboard View disables the active-workspace imports.
  it('Import queries is enabled on Query and Dashboard Edit, and Edit-mode-only in View', () => {
    expect(state(ctx({ surface: QUERY }), 'import-queries')).toEqual([true, null]);
    expect(state(ctx({ surface: edit('d1') }), 'import-queries')).toEqual([true, null]);
    expect(state(ctx({ surface: edit(null) }), 'import-queries')).toEqual([true, null]);
    expect(state(ctx({ surface: view('d1') }), 'import-queries')).toEqual([false, 'Edit mode only']);
  });

  // Import queries deliberately keeps NO workspace clause: the legacy
  // no-aggregate path imports through the state-derived fallback, and #452 must
  // not change existing import semantics.
  it('Import queries does not additionally require a resolved workspace', () => {
    expect(state(ctx({ hasWorkspace: false }), 'import-queries')).toEqual([true, null]);
  });

  // Issue test 8.
  it('both Library downloads follow the Library projection count', () => {
    for (const id of ['download-md', 'download-sql'] as const) {
      expect(state(ctx({ libraryQueryCount: 1 }), id)).toEqual([true, null]);
      expect(state(ctx({ libraryQueryCount: 0 }), id)).toEqual([false, 'No Library queries']);
    }
  });

  it('a workspace full of Dashboard-owned queries still disables the downloads', () => {
    // The caller passes the ZERO-OWNER projection; a workspace whose every query
    // is owned projects to 0 here, which is what keeps the rows off.
    expect(state(ctx({ libraryQueryCount: 0, dashboardCount: 3 }), 'download-sql'))
      .toEqual([false, 'No Library queries']);
  });
});

describe('fileMenuModel — Dashboard operations', () => {
  // Issue test 3 + acceptance "Dashboard import/export remain visible while
  // Query is open, with clear disabled reasons".
  it('Query disables BOTH Dashboard rows rather than hiding them', () => {
    const query = ctx({ surface: QUERY });
    expect(state(query, 'import-dashboard')).toEqual([false, 'Open a dashboard']);
    expect(state(query, 'export-dashboard')).toEqual([false, 'Open a dashboard']);
    expect(fileMenuModel(query).items.map((item) => item.id)).toEqual(ORDER);
  });

  // Issue test 10: no implicit compatibility fallback from Query mode.
  it('Query yields NO Dashboard target, even with Dashboards present', () => {
    const model = fileMenuModel(ctx({ surface: QUERY, dashboardCount: 5 }));
    expect(model.importDashboardTarget).toBeNull();
    expect(model.exportDashboardTarget).toBeNull();
  });

  // Issue test 4.
  it('Dashboard Edit enables both rows against the EXACT active Dashboard', () => {
    const model = fileMenuModel(ctx({ surface: edit('d7'), dashboardCount: 3 }));
    expect(state(ctx({ surface: edit('d7') }), 'import-dashboard')).toEqual([true, null]);
    expect(state(ctx({ surface: edit('d7') }), 'export-dashboard')).toEqual([true, null]);
    expect(model.importDashboardTarget).toEqual({ kind: 'exact', dashboardId: 'd7' });
    expect(model.exportDashboardTarget).toEqual({ dashboardId: 'd7' });
  });

  // Issue test 5.
  it('Dashboard View exports the exact Dashboard but refuses to import', () => {
    const viewing = ctx({ surface: view('d7') });
    expect(state(viewing, 'export-dashboard')).toEqual([true, null]);
    expect(fileMenuModel(viewing).exportDashboardTarget).toEqual({ dashboardId: 'd7' });
    expect(state(viewing, 'import-dashboard')).toEqual([false, 'Edit mode only']);
    expect(fileMenuModel(viewing).importDashboardTarget).toBeNull();
  });

  // Issue test 6.
  it('the empty Dashboard placeholder imports (creating the first) and cannot export', () => {
    const empty = ctx({ surface: edit(null), dashboardCount: 0 });
    expect(state(empty, 'import-dashboard')).toEqual([true, null]);
    expect(fileMenuModel(empty).importDashboardTarget).toEqual({ kind: 'create-first' });
    expect(state(empty, 'export-dashboard')).toEqual([false, 'No dashboard']);
    expect(fileMenuModel(empty).exportDashboardTarget).toBeNull();
  });

  // The C1 defect: the placeholder is ALSO reached when a selection stops
  // resolving against a non-empty collection. `create-first` commits through the
  // compatibility slot, so offering it there would overwrite Dashboard #1.
  it('an unresolvable selection over a NON-empty collection refuses to import', () => {
    const stale = ctx({ surface: edit(null), dashboardCount: 2 });
    expect(state(stale, 'import-dashboard')).toEqual([false, 'Dashboard unavailable']);
    expect(fileMenuModel(stale).importDashboardTarget).toBeNull();
    expect(state(stale, 'export-dashboard')).toEqual([false, 'No dashboard']);
  });

  it('a read-only placeholder is Edit-mode-only before it is anything else', () => {
    expect(state(ctx({ surface: view(null), dashboardCount: 0 }), 'import-dashboard'))
      .toEqual([false, 'Edit mode only']);
  });

  it('a Dashboard surface with no resolved workspace cannot import or export', () => {
    const missing = ctx({ surface: edit(null), hasWorkspace: false, dashboardCount: 0 });
    expect(state(missing, 'import-dashboard')).toEqual([false, 'No workspace']);
    expect(state(missing, 'export-dashboard')).toEqual([false, 'No dashboard']);
    expect(fileMenuModel(missing).importDashboardTarget).toBeNull();
    expect(fileMenuModel(missing).exportDashboardTarget).toBeNull();
  });

  // The invariant `ui/file-menu.ts` relies on to dispatch without a null check.
  it('a target is non-null exactly when its row is enabled', () => {
    const surfaces = [QUERY, edit('d1'), view('d1'), edit(null), view(null)];
    for (const surface of surfaces) {
      for (const hasWorkspace of [true, false]) {
        for (const dashboardCount of [0, 2]) {
          const model = fileMenuModel({ surface, hasWorkspace, libraryQueryCount: 1, dashboardCount });
          const enabled = (id: FileMenuActionId): boolean =>
            model.items.find((item) => item.id === id)!.enabled;
          expect(model.importDashboardTarget !== null).toBe(enabled('import-dashboard'));
          expect(model.exportDashboardTarget !== null).toBe(enabled('export-dashboard'));
        }
      }
    }
  });
});

describe('fileMenuFooter', () => {
  // Issue test 9 + "singular/plural forms remain grammatical", "zero counts are
  // displayed normally rather than changing the menu structure".
  it.each([
    [0, 0, '0 Library queries · 0 dashboards'],
    [1, 0, '1 Library query · 0 dashboards'],
    [1, 1, '1 Library query · 1 dashboard'],
    [2, 1, '2 Library queries · 1 dashboard'],
    [7, 3, '7 Library queries · 3 dashboards'],
  ])('reports %i Library queries and %i dashboards as "%s"', (libraryQueryCount, dashboardCount, expected) => {
    const c = ctx({ libraryQueryCount, dashboardCount });
    expect(fileMenuFooter(c)).toBe(expected);
    expect(fileMenuModel(c).footer).toBe(expected);
  });

  it('reports the same counts whatever the surface', () => {
    for (const surface of [QUERY, edit('d1'), view('d1'), edit(null)]) {
      expect(fileMenuFooter(ctx({ surface, libraryQueryCount: 4, dashboardCount: 2 })))
        .toBe('4 Library queries · 2 dashboards');
    }
  });
});
