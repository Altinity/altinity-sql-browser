import { describe, it, expect } from 'vitest';
import {
  fileMenuModel, fileMenuFooter, shortIdFragments,
} from '../../src/core/file-menu-model.js';
import type {
  FileMenuActionId, FileMenuContext, FileMenuItemSpec, FileMenuSurface,
} from '../../src/core/file-menu-model.js';

// The settled row order (#452, regrouped by verb in #463). Every assertion about
// "the same menu everywhere" compares against this one list, so a reordering
// breaks every surface's spec at once rather than silently passing on the
// surface nobody re-fixtured.
const ORDER: FileMenuActionId[] = [
  'new-workspace', 'new-dashboard',
  'import-workspace', 'import-queries', 'import-dashboard',
  'export-workspace', 'export-dashboard',
  'download-md', 'download-sql',
];

const LABELS = [
  'New workspace…', 'New dashboard…',
  'Import workspace…', 'Import queries…', 'Import dashboard…',
  'Export workspace…', 'Export dashboard…',
  'Download Library as Markdown', 'Download Library as SQL',
];

const QUERY: FileMenuSurface = { surface: 'query' };
const edit = (dashboardId: string | null): FileMenuSurface =>
  ({ surface: 'dashboard', mode: 'edit', dashboardId });
const view = (dashboardId: string | null): FileMenuSurface =>
  ({ surface: 'dashboard', mode: 'view', dashboardId });

const ctx = (over: Partial<FileMenuContext> = {}): FileMenuContext => ({
  surface: QUERY, hasWorkspace: true, libraryQueryCount: 3, dashboardIds: ['d1'], ...over,
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
  it.each(SURFACES)('%s renders all nine rows, same ids, same labels, same order', (_name, surface) => {
    const model = fileMenuModel(ctx({ surface }));
    expect(model.items.map((item) => item.id)).toEqual(ORDER);
    expect(model.items.map((item) => item.label)).toEqual(LABELS);
  });

  // Issue acceptance: "Menu rows do not appear, disappear, or reorder when the
  // work surface changes." Asserted across the whole cartesian product rather
  // than per case, so a future rule that filters instead of disabling cannot
  // slip through.
  it('never adds, removes, reorders or relabels a row for ANY context', () => {
    const surfaces = [QUERY, edit('d1'), view('d1'), edit(null), view(null)];
    for (const surface of surfaces) {
      for (const hasWorkspace of [true, false]) {
        for (const libraryQueryCount of [0, 1, 7]) {
          for (const dashboardIds of [[], ['d1'], ['d1', 'd2', 'd3', 'd4']]) {
            const model = fileMenuModel({ surface, hasWorkspace, libraryQueryCount, dashboardIds });
            expect(model.items.map((item) => item.id)).toEqual(ORDER);
            expect(model.items.map((item) => item.label)).toEqual(LABELS);
          }
        }
      }
    }
  });

  // #463: the menu is grouped by VERB — create / import / export / download.
  it('divides the four verb groups, and only those', () => {
    const model = fileMenuModel(ctx());
    expect(model.items.filter((item) => item.separatorBefore).map((item) => item.id))
      .toEqual(['import-workspace', 'export-workspace', 'download-md']);
  });

  it('groups the same way whatever the context', () => {
    for (const surface of [QUERY, edit('d1'), view(null)]) {
      for (const hasWorkspace of [true, false]) {
        const model = fileMenuModel(ctx({ surface, hasWorkspace, dashboardIds: [], libraryQueryCount: 0 }));
        expect(model.items.filter((item) => item.separatorBefore).map((item) => item.id))
          .toEqual(['import-workspace', 'export-workspace', 'download-md']);
      }
    }
  });

  // Sentence case (#463): `dashboard`, not `Dashboard`, inside a label.
  it('spells dashboard in sentence case in every label', () => {
    for (const item of fileMenuModel(ctx()).items) {
      expect(item.label).not.toContain('Dashboard');
    }
  });

  it('keeps the file extension on a row independent of its availability', () => {
    expect(byId(ctx(), 'export-workspace').meta).toBe('.json');
    expect(byId(ctx(), 'export-dashboard').meta).toBe('.json');
    expect(byId(ctx(), 'download-md').meta).toBe('.md');
    expect(byId(ctx(), 'download-sql').meta).toBe('.sql');
    expect(byId(ctx(), 'new-workspace').meta).toBeNull();
    expect(byId(ctx(), 'new-dashboard').meta).toBeNull();
    // Disabled rows keep their extension AND carry a reason.
    const disabled = byId(ctx({ libraryQueryCount: 0 }), 'download-md');
    expect(disabled).toMatchObject({ meta: '.md', enabled: false, reason: 'No Library queries' });
  });

  it('reports a reason exactly when a row is disabled', () => {
    for (const surface of [QUERY, edit('d1'), view('d1'), edit(null)]) {
      for (const item of fileMenuModel(ctx({
        surface, hasWorkspace: false, libraryQueryCount: 0, dashboardIds: [],
      })).items) {
        expect(item.enabled).toBe(item.reason === null);
      }
    }
  });
});

describe('fileMenuModel — workspace operations', () => {
  it('New workspace and Import workspace need nothing at all', () => {
    const nothing = ctx({ surface: view(null), hasWorkspace: false, libraryQueryCount: 0, dashboardIds: [] });
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

describe('fileMenuModel — New dashboard (#463)', () => {
  // Acceptance: "The File menu contains New dashboard… in the agreed stable
  // position on every surface" — immediately after New workspace…, always.
  it('sits immediately after New workspace on every surface', () => {
    for (const [, surface] of SURFACES) {
      const ids = fileMenuModel(ctx({ surface })).items.map((item) => item.id);
      expect(ids.indexOf('new-dashboard')).toBe(ids.indexOf('new-workspace') + 1);
    }
  });

  it('needs a writable workspace and nothing else', () => {
    for (const [, surface] of SURFACES) {
      for (const dashboardIds of [[], ['d1'], ['d1', 'd2']]) {
        expect(state(ctx({ surface, dashboardIds }), 'new-dashboard')).toEqual([true, null]);
      }
    }
    expect(state(ctx({ hasWorkspace: false }), 'new-dashboard')).toEqual([false, 'No workspace']);
  });

  // Creation opens the new Dashboard in Edit mode, so being in View mode is not
  // a reason to refuse — unlike Import queries, which edits what is on screen.
  it('is available in Dashboard View mode', () => {
    expect(state(ctx({ surface: view('d1') }), 'new-dashboard')).toEqual([true, null]);
    expect(state(ctx({ surface: view('d1') }), 'import-queries')).toEqual([false, 'Edit mode only']);
  });
});

describe('fileMenuModel — Library operations', () => {
  // Issue test 5: Dashboard View disables the active-workspace query import.
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
    expect(state(ctx({ libraryQueryCount: 0, dashboardIds: ['d1', 'd2', 'd3'] }), 'download-sql'))
      .toEqual([false, 'No Library queries']);
  });
});

describe('fileMenuModel — Import dashboard is additive (#463)', () => {
  // Acceptance: "Import dashboard… is additive and does not require an open
  // Dashboard." Every surface, every collection size, one rule.
  it('is available on every surface whenever a workspace is writable', () => {
    for (const [, surface] of SURFACES) {
      for (const dashboardIds of [[], ['d1'], ['d1', 'd2']]) {
        expect(state(ctx({ surface, dashboardIds }), 'import-dashboard')).toEqual([true, null]);
      }
    }
    expect(state(ctx({ surface: view(null), dashboardIds: [] }), 'import-dashboard')).toEqual([true, null]);
  });

  it('needs only a workspace', () => {
    expect(state(ctx({ hasWorkspace: false }), 'import-dashboard')).toEqual([false, 'No workspace']);
  });

  // The three reasons #463 removes from this row. Asserted by absence over the
  // whole product, because each one used to fire on a different surface.
  it('never reports a surface-derived reason again', () => {
    const gone = ['Open a dashboard', 'Edit mode only', 'Dashboard unavailable', 'No dashboard'];
    for (const surface of [QUERY, edit('d1'), view('d1'), edit(null), view(null)]) {
      for (const dashboardIds of [[], ['d1'], ['d1', 'd2']]) {
        expect(gone).not.toContain(byId(ctx({ surface, dashboardIds }), 'import-dashboard').reason);
      }
    }
  });

  // The model no longer carries an import target at all: there is nothing for a
  // caller to aim, so nothing that can be aimed at `dashboards[0]`.
  it('exposes no import target for any caller to retarget', () => {
    expect(fileMenuModel(ctx({ surface: edit('d1') }))).not.toHaveProperty('importDashboardTarget');
  });
});

describe('fileMenuModel — Export dashboard is workspace-aware (#463)', () => {
  // "zero Dashboards: disabled with `No dashboards`".
  it('is disabled with No dashboards for an empty collection, on every surface', () => {
    for (const [, surface] of SURFACES) {
      const empty = ctx({ surface, dashboardIds: [] });
      expect(state(empty, 'export-dashboard')).toEqual([false, 'No dashboards']);
      expect(fileMenuModel(empty).exportDashboardTarget).toBeNull();
    }
  });

  // "one Dashboard: export that Dashboard directly" — including from Query,
  // where nothing is open. The sole entry is named by id, never by position.
  it('exports the sole Dashboard directly from any surface', () => {
    for (const surface of [QUERY, edit(null), view(null)]) {
      const one = ctx({ surface, dashboardIds: ['only'] });
      expect(state(one, 'export-dashboard')).toEqual([true, null]);
      expect(fileMenuModel(one).exportDashboardTarget).toEqual({ kind: 'exact', dashboardId: 'only' });
    }
  });

  // Owner decision (#463): with a Dashboard on screen, Export exports THAT one
  // directly — no chooser — in both modes.
  it('exports the open Dashboard directly, in View as well as Edit', () => {
    for (const surface of [edit('d7'), view('d7')]) {
      const open = ctx({ surface, dashboardIds: ['d1', 'd7', 'd9'] });
      expect(state(open, 'export-dashboard')).toEqual([true, null]);
      expect(fileMenuModel(open).exportDashboardTarget).toEqual({ kind: 'exact', dashboardId: 'd7' });
    }
  });

  // "multiple Dashboards with no exact Dashboard open: show a Dashboard chooser".
  it('asks for a chooser from Query, and from an unresolved Dashboard selection', () => {
    for (const surface of [QUERY, edit(null), view(null)]) {
      const many = ctx({ surface, dashboardIds: ['d1', 'd2'] });
      expect(state(many, 'export-dashboard')).toEqual([true, null]);
      expect(fileMenuModel(many).exportDashboardTarget).toEqual({ kind: 'choose' });
    }
  });

  // The C1 defect, restated for export: a selection that stopped resolving must
  // not silently export a different Dashboard.
  it('falls through to the chooser when the open id is no longer in the collection', () => {
    const stale = ctx({ surface: edit('gone'), dashboardIds: ['d1', 'd2'] });
    expect(fileMenuModel(stale).exportDashboardTarget).toEqual({ kind: 'choose' });
  });

  // A stale selection over a ONE-Dashboard collection resolves that one — the
  // single answer the workspace has — and still never reads `dashboardIds[0]`
  // as a positional fallback.
  it('never resolves a stale selection to the entry that happens to be first', () => {
    const stale = ctx({ surface: edit('gone'), dashboardIds: ['survivor'] });
    expect(fileMenuModel(stale).exportDashboardTarget).toEqual({ kind: 'exact', dashboardId: 'survivor' });
  });

  // A duplicate-id workspace is ambiguous, and the exactly-one-match rule is the
  // same one `workspace-dashboards.ts` enforces on the write side.
  it('refuses to resolve an ambiguous open id and asks for the chooser instead', () => {
    const dup = ctx({ surface: edit('twin'), dashboardIds: ['twin', 'twin', 'other'] });
    expect(fileMenuModel(dup).exportDashboardTarget).toEqual({ kind: 'choose' });
  });

  it('a Dashboard surface with no resolved workspace can still export what the workspace holds', () => {
    // `hasWorkspace` gates the WRITES. Export reads, and the collection it reads
    // is the caller's own list — so the two are independent by construction.
    const missing = ctx({ surface: edit(null), hasWorkspace: false, dashboardIds: [] });
    expect(state(missing, 'export-dashboard')).toEqual([false, 'No dashboards']);
    expect(state(missing, 'new-dashboard')).toEqual([false, 'No workspace']);
    expect(state(missing, 'import-dashboard')).toEqual([false, 'No workspace']);
  });

  // The invariant `ui/file-menu.ts` relies on to dispatch without a null check.
  it('a target is non-null exactly when the row is enabled', () => {
    const surfaces = [QUERY, edit('d1'), view('d1'), edit(null), view(null)];
    for (const surface of surfaces) {
      for (const hasWorkspace of [true, false]) {
        for (const dashboardIds of [[], ['d1'], ['d1', 'd2']]) {
          const model = fileMenuModel({ surface, hasWorkspace, libraryQueryCount: 1, dashboardIds });
          const enabled = model.items.find((item) => item.id === 'export-dashboard')!.enabled;
          expect(model.exportDashboardTarget !== null).toBe(enabled);
        }
      }
    }
  });
});

describe('shortIdFragments — telling duplicate-titled rows apart (#463)', () => {
  it('shows a six-character tail when that is already unique', () => {
    expect(shortIdFragments(['ws-dashboard-aaa111', 'ws-dashboard-bbb222']))
      .toEqual(['aaa111', 'bbb222']);
  });

  // The defect a fixed-width tail has: `sales-abcdef` and `ops-abcdef` agree on
  // their last six characters, so two rows with the same title and tile count
  // would render identically.
  it('grows the tail until every fragment differs', () => {
    // Both collide through length 8 (`s-abcdef`); 9 is the first that separates.
    expect(shortIdFragments(['sales-abcdef', 'ops-abcdef'])).toEqual(['es-abcdef', 'ps-abcdef']);
  });

  it('falls back to the whole id when no suffix separates them', () => {
    // Genuinely duplicate ids — nothing can distinguish these, and the
    // id-addressed reader fails closed on that workspace anyway.
    expect(shortIdFragments(['same-id', 'same-id'])).toEqual(['same-id', 'same-id']);
  });

  it('never returns a fragment longer than its own id', () => {
    for (const fragment of shortIdFragments(['ab', 'cd'])) expect(fragment).toHaveLength(2);
  });

  it('handles a single id and an empty list', () => {
    expect(shortIdFragments(['only-one-id'])).toEqual(['one-id']);
    expect(shortIdFragments([])).toEqual([]);
  });

  // One fragment per id, positionally — the caller zips these back onto rows.
  it('returns one fragment per id, in order', () => {
    const ids = ['ws-1-aaaaaa', 'ws-2-bbbbbb', 'ws-3-cccccc'];
    expect(shortIdFragments(ids)).toHaveLength(ids.length);
  });
});

describe('fileMenuFooter', () => {
  // Issue test 9 + "singular/plural forms remain grammatical", "zero counts are
  // displayed normally rather than changing the menu structure".
  it.each([
    [0, [] as string[], '0 Library queries · 0 dashboards'],
    [1, [], '1 Library query · 0 dashboards'],
    [1, ['a'], '1 Library query · 1 dashboard'],
    [2, ['a'], '2 Library queries · 1 dashboard'],
    [7, ['a', 'b', 'c'], '7 Library queries · 3 dashboards'],
  ])('reports %i Library queries and %o as "%s"', (libraryQueryCount, dashboardIds, expected) => {
    const c = ctx({ libraryQueryCount, dashboardIds });
    expect(fileMenuFooter(c)).toBe(expected);
    expect(fileMenuModel(c).footer).toBe(expected);
  });

  it('reports the same counts whatever the surface', () => {
    for (const surface of [QUERY, edit('d1'), view('d1'), edit(null)]) {
      expect(fileMenuFooter(ctx({ surface, libraryQueryCount: 4, dashboardIds: ['a', 'b'] })))
        .toBe('4 Library queries · 2 dashboards');
    }
  });
});
