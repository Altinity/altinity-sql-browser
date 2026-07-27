import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  libraryControls, renderLibraryTitle, openFileMenu,
  exportDashboardAction, disposeFileMenuOverlays, startImportExampleDashboard,
} from '../../src/ui/file-menu.js';
import { EXAMPLE_DASHBOARDS } from '../../src/generated/example-dashboards.js';
import { queryName } from '../../src/core/saved-query.js';
import { decodePortableBundleJson } from '../../src/dashboard/model/portable-bundle-codec.js';
import { makeApp, statefulWorkspaceRepo } from '../helpers/fake-app.js';
import type { MakeAppOverrides } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';
import type { FileMenuSurfaceContext } from '../../src/ui/file-menu.js';
import type { App } from '../../src/ui/app.types.js';
import type { DashboardDocumentV2, PortableBundleV2, SavedQueryV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';
import { handleKeydown } from '../../src/ui/shortcuts.js';

const click = (el: Element): boolean => el.dispatchEvent(new Event('click', { bubbles: true }));
const key = (target: EventTarget, k: string, mods: KeyboardEventInit = {}): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }));
const item = (re: RegExp): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.fm-item')].find((b) => re.test(b.textContent || ''));
const toast = (): string | null => document.querySelector('.share-toast')!.textContent;
const setSaved = (app: App, queries: SavedQueryFixture[]): void => {
  app.state.savedQueries = queries.map((q) => savedQuery(q));
};
// Flush the microtask queue — every commit path here is async (`app.workspace
// .commit` always returns a Promise), so an assertion made right after firing
// a UI event needs one tick before the projection lands.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r));
const loadActiveWorkspace = async (app: App): Promise<StoredWorkspaceV5> => {
  const loaded = await app.workspace.loadById(app.state.workspaceId);
  if (loaded.status !== 'ok') throw new Error(`Expected active workspace, got ${loaded.status}`);
  return loaded.workspace;
};

// A FileReader stub: readAsText resolves synchronously with `content` (or errors).
// Implements the full (mostly-unused) `FileReader` interface honestly — rather
// than casting a partial shape — so the only member this file actually
// exercises, `readAsText`, is genuinely type-safe to call from file-menu.ts's
// `new (app.FileReader || globalThis.FileReader)()`.
const fakeReader = (content: string, fail?: boolean): typeof FileReader => class {
  static readonly EMPTY = 0 as const;
  static readonly LOADING = 1 as const;
  static readonly DONE = 2 as const;
  readonly EMPTY = 0 as const;
  readonly LOADING = 1 as const;
  readonly DONE = 2 as const;
  readonly error: DOMException | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  onloadstart: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  readonly readyState: 0 | 1 | 2 = 0;
  result: string | ArrayBuffer | null = null;
  abort(): void {}
  readAsArrayBuffer(): void {}
  readAsBinaryString(): void {}
  readAsDataURL(): void {}
  readAsText(): void { this.result = content; if (fail) this.onerror?.(); else this.onload?.(); }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true; }
};

// ── portable-bundle / Dashboard fixtures (mirror import-planner.test.ts) ────

const panelQuery = (id: string, name = id, sql = 'SELECT 1'): SavedQueryV2 => ({
  id, sql, specVersion: 1, spec: { name, panel: { cfg: { type: 'bar', x: 0, y: [1] } } },
});
const dashboardDoc = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
});
const bundleDoc = (over: Partial<PortableBundleV2> = {}): PortableBundleV2 => ({
  format: 'altinity-sql-browser/portable-bundle', version: 2,
  exportedAt: '2026-07-17T00:00:00.000Z', queries: [], dashboards: [], ...over,
});
const bundleText = (over: Partial<PortableBundleV2> = {}): string => JSON.stringify(bundleDoc(over));
const legacyFile = (queries: unknown[]): string =>
  JSON.stringify({ format: 'altinity-sql-browser/saved-queries', version: 1, queries });

// #452: the Query surface's context is the default. A Dashboard-context control
// is mounted with `mountOn(...)`.
function mount<O extends MakeAppOverrides = Record<string, never>>(over: O = {} as O) {
  const app = makeApp(over);
  for (const node of libraryControls(app)) document.body.appendChild(node);
  return app;
}
/** Mount the shared control with an explicit surface context (Dashboard Edit /
 *  View / placeholder), the way `buildAppHeader` does for each surface. */
function mountOn<O extends MakeAppOverrides = Record<string, never>>(
  context: FileMenuSurfaceContext, over: O = {} as O,
) {
  const app = makeApp(over);
  for (const node of libraryControls(app, context)) document.body.appendChild(node);
  return app;
}
const dashEdit = (dashboardId: string | null = 'd1'): FileMenuSurfaceContext =>
  ({ surface: 'dashboard', mode: 'edit', dashboardId });
const dashView = (dashboardId: string | null = 'd1'): FileMenuSurfaceContext =>
  ({ surface: 'dashboard', mode: 'view', dashboardId });

/** The menu's own row labels, in render order. */
const menuLabels = (): string[] =>
  [...document.querySelectorAll('.file-menu .fm-item .fm-label')].map((el) => el.textContent || '');
const row = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('.file-menu .fm-item')]
    .find((b) => b.querySelector('.fm-label')?.textContent === label)!;
const reasonOf = (label: string): string | null =>
  row(label).querySelector('.fm-reason')?.textContent ?? null;

// #452: the menu parents THREE hidden pickers (Import queries, Import workspace,
// Import Dashboard), each tagged with the row that triggers it. Addressed by
// that tag, never by append order, so adding a fourth picker cannot silently
// repoint an existing spec at the wrong input.
const PICKER_OWNER: Record<string, string> = {
  'Import queries…': 'import-queries',
  'Import workspace…': 'import-workspace',
  'Import dashboard…': 'import-dashboard',
};
const picker = (label: string): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`.file-menu input[data-picker="${PICKER_OWNER[label]}"]`)!;
const pickFile = (input: HTMLInputElement, name = 'file.json'): void => {
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name }] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
};
/** Drive Import dashboard the way a user does: open the shared menu, grab its
 *  menu-parented picker, click the row, then pick a file. #452 removed the old
 *  body-mounted no-menu entry point, and #463 made the row additive on every
 *  surface — so the Query surface is now a legitimate starting point. */
const pickDashboardImport = (
  app: App, context?: FileMenuSurfaceContext, name = 'file.json',
): void => {
  openFileMenu(app, context);
  const input = picker('Import dashboard…');
  click(row('Import dashboard…'));
  pickFile(input, name);
};

/** Open the example-dashboard dialog (#506) the way a user does: open the
 *  shared menu, click the row. Returns the dialog card for the caller to
 *  drive further (select a row, click Import/Cancel). */
const openExampleDialog = (app: App, context?: FileMenuSurfaceContext): HTMLElement => {
  openFileMenu(app, context);
  click(row('Import example dashboard…'));
  return document.querySelector('.fm-dialog-card')!;
};
const exampleRadio = (name: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('.fm-dialog-card [role="radio"]')]
    .find((b) => b.textContent === name)!;

afterEach(() => document.body.replaceChildren());

describe('header File control', () => {
  it('the File header button opens the menu through its click handler', () => {
    const app = mount();
    click(app.dom.fileBtn!);
    expect(document.querySelector('.file-menu')).not.toBeNull();
  });
});

describe('workspace title', () => {
  it('renders the name + dirty dot; inline rename commits on Enter through the workspace aggregate', async () => {
    const app = mount();
    app.state.libraryName.value = 'My workspace';
    app.state.libraryDirty.value = true;
    renderLibraryTitle(app);
    expect(app.dom.libraryTitle!.querySelector('.lib-name-text')!.textContent).toBe('My workspace');
    expect(app.dom.libraryTitle!.querySelector('.lib-dirty')).not.toBeNull();
    click(app.dom.libraryTitle!.querySelector('.lib-name')!);
    expect(app.editingLibrary).toBe(true);
    const input = app.dom.libraryTitle!.querySelector<HTMLInputElement>('.lib-name-input')!;
    expect(input.value).toBe('My workspace');
    input.value = 'Renamed';
    key(input, 'Enter');
    expect(app.editingLibrary).toBe(false); // leaves edit mode immediately, before the commit resolves
    await flush();
    expect(app.state.libraryName.value).toBe('Renamed');
    expect(app.state.libraryDirty.value).toBe(false); // a fresh commit is never "unsaved"
  });

  it('inline rename: Escape cancels, blur commits, empty commit is a no-op, double-fire guarded', async () => {
    const app = mount();
    app.state.libraryName.value = 'Orig';
    renderLibraryTitle(app);
    // Escape cancels
    click(app.dom.libraryTitle!.querySelector('.lib-name')!);
    let input = app.dom.libraryTitle!.querySelector<HTMLInputElement>('.lib-name-input')!;
    input.value = 'X';
    key(input, 'Escape');
    expect(app.state.libraryName.value).toBe('Orig');
    // empty name commit → no rename
    click(app.dom.libraryTitle!.querySelector('.lib-name')!);
    input = app.dom.libraryTitle!.querySelector<HTMLInputElement>('.lib-name-input')!;
    input.value = '   ';
    key(input, 'Enter');
    expect(app.state.libraryName.value).toBe('Orig');
    // blur commits, then a second event on the detached input is guarded
    click(app.dom.libraryTitle!.querySelector('.lib-name')!);
    input = app.dom.libraryTitle!.querySelector<HTMLInputElement>('.lib-name-input')!;
    input.value = 'Blurred';
    input.dispatchEvent(new Event('blur'));
    await flush();
    expect(app.state.libraryName.value).toBe('Blurred');
    key(input, 'Enter');
    await flush();
    expect(app.state.libraryName.value).toBe('Blurred');
  });

  it('renderLibraryTitle no-ops without a slot', () => {
    expect(() => renderLibraryTitle(makeApp())).not.toThrow();
  });
});

// The settled row order — one list, compared against on every surface
// (#452, regrouped by verb in #463).
const ROWS = [
  'New workspace…', 'New dashboard…',
  'Import workspace…', 'Import queries…', 'Import dashboard…', 'Import example dashboard…',
  'Export workspace…', 'Export dashboard…',
  'Download Library as Markdown', 'Download Library as SQL',
];

describe('file menu structure', () => {
  it('lists every row in the settled order, with no section headings, and re-open is a no-op', () => {
    const app = mount();
    app.state.savedQueries = [panelQuery('s1', 'A'), panelQuery('s2', 'B')];
    openFileMenu(app);
    expect(menuLabels()).toEqual(ROWS);
    // #452 removed the per-surface section headings — they were the loudest way
    // the two old menus disagreed with each other.
    expect(document.querySelectorAll('.fm-section')).toHaveLength(0);
    expect(document.querySelector('.fm-checkbox')).toBeNull();
    expect(document.querySelector('.fm-count')!.textContent).toBe('2 Library queries · 0 dashboards');
    openFileMenu(app);
    expect(document.querySelectorAll('.file-menu')).toHaveLength(1);
    // …and the aria-expanded re-entrancy guard means the redundant open added
    // no orphan hidden pickers either (exactly the three from the first open).
    expect(document.querySelectorAll('.file-menu input[type=file]')).toHaveLength(3);
  });

  // Issue test 1 + 2: the SAME implementation, class and rows on every surface.
  it('renders identical rows, in identical order, under the same class on every surface', () => {
    for (const context of [undefined, dashEdit(), dashView(), dashEdit(null)]) {
      document.body.replaceChildren();
      const app = context ? mountOn(context) : mount();
      openFileMenu(app, context);
      expect(document.querySelectorAll('.file-menu')).toHaveLength(1);
      expect(menuLabels()).toEqual(ROWS);
      expect(document.querySelectorAll('.fm-section')).toHaveLength(0);
      // No surface-specific menu or item classes survive.
      expect(document.querySelector('.dash-file-menu')).toBeNull();
      expect(document.querySelector('.dash-fm-item')).toBeNull();
    }
  });

  it('autofocuses the first item (New workspace…) on open', async () => {
    const app = mount();
    openFileMenu(app);
    await flush();
    expect(document.activeElement).toBe(item(/New workspace/));
  });

  // #463: four verb groups — create / import / export / download — divided by
  // three separators, plus the footer's own.
  it('paints the four verb groups in order, divided and unlabelled', async () => {
    const app = mount();
    openFileMenu(app);
    // The three menu-parented hidden file pickers are not rows.
    const rows = [...document.querySelector('.file-menu')!.children]
      .filter((r) => !(r instanceof HTMLInputElement));
    // The rendered sequence: item×2, sep, item×4, sep, item×2, sep, item×2, sep, count.
    const shape = rows.map((r) => (r.classList.contains('fm-sep') ? '|'
      : r.classList.contains('fm-count') ? '#' : '.'));
    expect(shape.join('')).toBe('..|....|..|..|#');
    expect(rows.filter((r) => r.classList.contains('fm-item'))
      .map((r) => r.querySelector('.fm-label')!.textContent)).toEqual(ROWS);
    // Keyboard focus order matches the visual row order exactly — a separator
    // is skipped, not landed on.
    await flush();
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(item(/New dashboard/));
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(item(/Import workspace/));
  });

  // Issue test 9.
  it('the footer reports the Library projection count and the Dashboard count', () => {
    const app = mount({
      currentWorkspace: {
        storageVersion: 5, id: 'w', key: 'w', name: 'W',
        queries: [panelQuery('p1', 'Panel'), panelQuery('lib', 'Lib')],
        dashboards: [dashboardDoc({ id: 'd1', tiles: [{ id: 't1', queryId: 'p1' }] })],
      },
    });
    app.state.savedQueries = [panelQuery('p1', 'Panel'), panelQuery('lib', 'Lib')];
    openFileMenu(app);
    // `p1` is owned by d1's tile, so the LIBRARY projection is just `lib`.
    expect(document.querySelector('.fm-count')!.textContent).toBe('1 Library query · 1 dashboard');
  });

  it('reports zero counts normally rather than changing the menu structure', () => {
    const app = mount();
    openFileMenu(app);
    expect(document.querySelector('.fm-count')!.textContent).toBe('0 Library queries · 0 dashboards');
    expect(menuLabels()).toEqual(ROWS);
  });

  it('closes on overlay click and on Escape (ignores other keys)', () => {
    const app = mount();
    openFileMenu(app);
    key(document, 'a'); // not Escape → stays open
    expect(document.querySelector('.file-menu')).not.toBeNull();
    click(document.querySelector('.fm-overlay')!);
    expect(document.querySelector('.file-menu')).toBeNull();
    openFileMenu(app);
    key(document, 'Escape');
    expect(document.querySelector('.file-menu')).toBeNull();
  });
});

// Issue tests 3–8 at the DOM level: the pure matrix is covered in
// file-menu-model.test.ts; these pin that the rendering actually honours it —
// `disabled` + `aria-disabled`, a visible reason, and genuine inertness.
describe('file menu availability (#452)', () => {
  const openOn = (context: FileMenuSurfaceContext, over: MakeAppOverrides = {}) => {
    const app = mountOn(context, over);
    openFileMenu(app, context);
    return app;
  };

  /** A workspace holding exactly these Dashboard ids. */
  const withDashboards = (...idList: string[]): MakeAppOverrides => ({
    currentWorkspace: {
      storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [],
      dashboards: idList.map((id) => dashboardDoc({ id, title: id })),
    },
  });

  // #463: Query is no longer a reason to disable anything Dashboard-related —
  // the commands act on the workspace, which exists whether or not one is open.
  it('Query enables New/Import dashboard, and exports what the workspace holds', () => {
    openOn({ surface: 'query' }, withDashboards('a'));
    expect(menuLabels()).toEqual(ROWS); // still there, still in position
    for (const label of ['New dashboard…', 'Import dashboard…', 'Import example dashboard…', 'Export dashboard…']) {
      expect(row(label).getAttribute('aria-disabled')).toBeNull();
      expect(reasonOf(label)).toBeNull();
    }
  });

  it('Dashboard Edit enables all four Dashboard rows', () => {
    openOn(dashEdit('d1'), withDashboards('d1'));
    for (const label of ['New dashboard…', 'Import dashboard…', 'Import example dashboard…', 'Export dashboard…']) {
      expect(row(label).getAttribute('aria-disabled')).toBeNull();
      expect(reasonOf(label)).toBeNull();
    }
  });

  // #463: View mode no longer blocks Import dashboard — it adds a Dashboard
  // rather than editing the one being viewed. Import QUERIES still does.
  it('Dashboard View still refuses Import queries, but not the Dashboard rows', () => {
    openOn(dashView('d1'), withDashboards('d1'));
    expect(reasonOf('Import queries…')).toBe('Edit mode only');
    for (const label of ['New dashboard…', 'Import dashboard…', 'Import example dashboard…', 'Export dashboard…']) {
      expect(reasonOf(label)).toBeNull();
    }
  });

  it('the empty Dashboard placeholder imports and creates, and cannot export', () => {
    openOn(dashEdit(null));
    expect(row('Import dashboard…').getAttribute('aria-disabled')).toBeNull();
    expect(row('Import example dashboard…').getAttribute('aria-disabled')).toBeNull();
    expect(row('New dashboard…').getAttribute('aria-disabled')).toBeNull();
    expect(reasonOf('Export dashboard…')).toBe('No dashboards');
  });

  // The #452 defect this rendering used to guard against: the placeholder is
  // also reached when a selection stops resolving. Import is safe there now
  // (it appends), and Export falls through to the chooser rather than picking.
  it('an unresolvable selection over a non-empty collection still imports and exports', () => {
    openOn(dashEdit(null), withDashboards('a', 'b'));
    expect(reasonOf('Import dashboard…')).toBeNull();
    expect(reasonOf('Import example dashboard…')).toBeNull();
    expect(reasonOf('Export dashboard…')).toBeNull();
  });

  // #463 review: the workspace-not-found surface exists BECAUSE no aggregate
  // resolved, but `state.dashboard` can still be projecting the workspace the
  // user came from. Export must not offer to download a document that is not
  // there — the id list is gated on the workspace resolving at all.
  it('the workspace-not-found surface exports nothing, whatever state still projects', () => {
    const app = mountOn({ surface: 'dashboard', mode: 'edit', dashboardId: null, workspaceMissing: true });
    app.state.dashboard = dashboardDoc({ id: 'from-the-old-workspace', title: 'Ghost' });
    openFileMenu(app, { surface: 'dashboard', mode: 'edit', dashboardId: null, workspaceMissing: true });
    expect(reasonOf('Export dashboard…')).toBe('No dashboards');
    expect(document.querySelector('.fm-count')!.textContent).toBe('0 Library queries · 0 dashboards');
  });

  it('no active workspace disables what needs one, without moving a row', () => {
    openOn({ surface: 'dashboard', mode: 'edit', dashboardId: null, workspaceMissing: true });
    expect(menuLabels()).toEqual(ROWS);
    expect(reasonOf('Export workspace…')).toBe('No workspace');
    expect(reasonOf('Import dashboard…')).toBe('No workspace');
    expect(reasonOf('Import example dashboard…')).toBe('No workspace');
    expect(reasonOf('New dashboard…')).toBe('No workspace');
    // New/Import workspace need nothing at all — they stay reachable.
    expect(row('New workspace…').getAttribute('aria-disabled')).toBeNull();
    expect(row('Import workspace…').getAttribute('aria-disabled')).toBeNull();
  });

  it('an empty Library disables both downloads', () => {
    openOn({ surface: 'query' });
    for (const label of ['Download Library as Markdown', 'Download Library as SQL']) {
      expect(row(label).getAttribute('aria-disabled')).toBe('true');
      expect(reasonOf(label)).toBe('No Library queries');
      expect(row(label).querySelector('.fm-meta')!.textContent).toMatch(/^\.(md|sql)$/);
    }
  });

  // Issue: "disabled rows are announced but cannot activate". Announcement
  // requires the row to STAY reachable — a native `disabled` button is dropped
  // from the accessibility tree, so the reason would never be read out.
  it('a disabled row is reachable and announced, but activating it does nothing', async () => {
    // An empty collection: Export dashboard is the disabled Dashboard row now.
    const app = openOn({ surface: 'query' });
    await flush();
    const exportDash = row('Export dashboard…');
    // Reachable: arrowing from the row above lands ON it, not past it.
    row('Export workspace…').focus();
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(exportDash);
    // Announced: exposed to AT as a disabled menuitem carrying its reason.
    expect(exportDash.getAttribute('role')).toBe('menuitem');
    expect(exportDash.getAttribute('aria-disabled')).toBe('true');
    expect(exportDash.disabled).toBe(false);
    expect(reasonOf('Export dashboard…')).toBe('No dashboards');
    // …but inert: no handler at all, so the menu does not even close.
    click(exportDash);
    await flush();
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(document.querySelector('.file-menu')).not.toBeNull();
  });
});

describe('Export', () => {
  // #452: Export Dashboard takes an EXPLICIT target. There is no "whichever
  // Dashboard is current" call any more — that read is what let a Query-surface
  // export download the collection's first entry.
  it('exportDashboardAction fails closed when the target resolves to nothing', async () => {
    const app = mount();
    await exportDashboardAction(app, { workspaceId: app.state.workspaceId, workspaceName: app.state.libraryName.value, dashboardId: 'd1' });
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toBe('✕ That dashboard is no longer available');
  });

  it('exportDashboardAction downloads a valid bundle containing only its query dependencies', async () => {
    const app = mount();
    app.state.dashboard = dashboardDoc({ title: 'Ops', tiles: [{ id: 't1', queryId: 'p1' }] });
    app.state.savedQueries = [panelQuery('p1', 'Panel'), panelQuery('unrelated', 'Unrelated')];
    await exportDashboardAction(app, { workspaceId: app.state.workspaceId, workspaceName: app.state.libraryName.value, dashboardId: 'd1' });
    const [fname, mime, content] = app.downloadFile.mock.calls[0];
    expect(fname).toBe('Ops.json');
    expect(mime).toBe('application/json');
    const decoded = decodePortableBundleJson(content as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.queries.map((q) => q.id)).toEqual(['p1']); // unrelated query excluded
      expect(decoded.value.dashboards).toHaveLength(1);
    }
    expect(toast()).toBe('Exported → .json');
  });

  it('exportDashboardAction toasts the encode diagnostic instead of downloading for a role-incompatible Dashboard', async () => {
    const setupQuery: SavedQueryV2 = {
      id: 'f1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'F', dashboard: { role: 'setup' } },
    };
    const app = mount();
    // A tile referencing a Setup-role query (#447: `setup` is the only
    // non-panel role left) — legal to ASSEMBLE (Wave 1's pure builder never
    // re-validates), but `encodePortableBundleJson`'s own re-validation
    // catches the role mismatch.
    app.state.dashboard = dashboardDoc({ tiles: [{ id: 't1', queryId: 'f1' }] });
    app.state.savedQueries = [setupQuery];
    await exportDashboardAction(app, { workspaceId: app.state.workspaceId, workspaceName: app.state.libraryName.value, dashboardId: 'd1' });
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toMatch(/^✕ /);
  });

  // #341: the export must build from the latest COMMITTED workspace
  // (`loadCurrent`), not stale `app.state` — the whole reason the actions
  // became async (flush pending writes → read back the aggregate).
  it('exportWorkspaceAction builds the bundle from the committed workspace (loadCurrent), not stale app.state (#341)', async () => {
    const committed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'committed_lib', name: 'Committed Lib',
      queries: [panelQuery('c1', 'Committed')], dashboards: [],
    };
    const app = mount({ workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) } });
    // app.state is deliberately DIFFERENT — a regression reading state instead
    // of the committed aggregate would export THIS, failing the id assertion.
    app.state.savedQueries = [panelQuery('stale', 'Stale')];
    openFileMenu(app);
    click(item(/Export workspace/)!);
    await flush();
    const [, , content] = app.downloadFile.mock.calls[0];
    const decoded = decodePortableBundleJson(content as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.queries.map((q) => q.id)).toEqual(['c1']);
  });

  it('exportDashboardAction builds from the committed dashboard (loadCurrent), not stale app.state (#341)', async () => {
    const committed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'lib', name: 'Lib',
      queries: [panelQuery('c1', 'Committed')],
      dashboards: [dashboardDoc({ title: 'Committed', tiles: [{ id: 't1', queryId: 'c1' }] })],
    };
    const app = mount({ workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) } });
    app.state.dashboard = dashboardDoc({ title: 'Stale', tiles: [{ id: 't9', queryId: 'stale' }] });
    app.state.savedQueries = [panelQuery('stale', 'Stale')];
    await exportDashboardAction(app, { workspaceId: app.state.workspaceId, workspaceName: app.state.libraryName.value, dashboardId: 'd1' });
    const [fname, , content] = app.downloadFile.mock.calls[0];
    expect(fname).toBe('Committed.json'); // committed title, not the stale one
    const decoded = decodePortableBundleJson(content as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.queries.map((q) => q.id)).toEqual(['c1']);
  });

  // #341: `loadCurrent()` (IndexedDB) can REJECT (blocked/quota/private-mode) —
  // the export must fall back to `app.state`, never become a silent no-op on an
  // unhandled rejection (a regression from the pre-#341 synchronous export).
  it('exportWorkspaceAction falls back to app.state when loadCurrent rejects — never a silent no-op (#341)', async () => {
    const app = mount({ workspace: { loadById: async () => { throw new Error('idb blocked'); } } });
    app.state.libraryName.value = 'My Lib';
    app.state.savedQueries = [panelQuery('p1'), panelQuery('p2')];
    openFileMenu(app);
    click(item(/Export workspace/)!);
    await flush();
    expect(app.downloadFile).toHaveBeenCalled();
    const [fname, , content] = app.downloadFile.mock.calls[0];
    expect(fname).toBe('My Lib.json');
    const decoded = decodePortableBundleJson(content as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.queries.map((q) => q.id)).toEqual(['p1', 'p2']);
  });

  // #424: a workspace export carries EVERY stored Dashboard, not just the one
  // the UI exposes — including on the degraded fallback path, where the
  // envelope must come from `app.currentWorkspace` (the full collection)
  // rather than from `app.state.dashboard` (the compatibility projection).
  it('exportWorkspaceAction exports every stored Dashboard, in workspace order', async () => {
    const committed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'lib', name: 'Lib',
      queries: [panelQuery('c1', 'Committed')],
      dashboards: [
        dashboardDoc({ id: 'visible', title: 'Visible', tiles: [{ id: 't1', queryId: 'c1' }] }),
        dashboardDoc({ id: 'hidden', title: 'Hidden', revision: 12 }),
      ],
    };
    const app = mount({ workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) } });
    openFileMenu(app);
    click(item(/Export workspace/)!);
    await flush();
    const [, , content] = app.downloadFile.mock.calls[0];
    const decoded = decodePortableBundleJson(content as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.dashboards.map((d) => d.id)).toEqual(['visible', 'hidden']);
      expect(decoded.value.dashboards[1].revision).toBe(12);
    }
  });

  it('exportWorkspaceAction keeps every Dashboard on the degraded state fallback', async () => {
    const app = mount({ workspace: { loadById: async () => { throw new Error('idb blocked'); } } });
    app.state.libraryName.value = 'My Lib';
    app.state.savedQueries = [panelQuery('p1')];
    const visible = dashboardDoc({ id: 'visible', title: 'Visible' });
    const hidden = dashboardDoc({ id: 'hidden', title: 'Hidden', revision: 12 });
    // The full collection lives on `app.currentWorkspace`; `state.dashboard`
    // only ever projects the compatibility entry.
    app.currentWorkspace = {
      storageVersion: 5, id: 'w1', key: 'lib', name: 'My Lib',
      queries: app.state.savedQueries, dashboards: [visible, hidden],
    };
    app.state.dashboard = visible;
    openFileMenu(app);
    click(item(/Export workspace/)!);
    await flush();
    const [, , content] = app.downloadFile.mock.calls[0];
    const decoded = decodePortableBundleJson(content as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.dashboards.map((d) => d.id)).toEqual(['visible', 'hidden']);
  });

  it('Export workspace downloads a valid bundle containing the whole catalog', async () => {
    const app = mount();
    app.state.libraryName.value = 'My Lib';
    app.state.savedQueries = [panelQuery('p1'), panelQuery('p2')];
    openFileMenu(app);
    click(item(/Export workspace/)!);
    await flush();
    const [fname, , content] = app.downloadFile.mock.calls[0];
    expect(fname).toBe('My Lib.json');
    const decoded = decodePortableBundleJson(content as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.queries.map((q) => q.id).sort()).toEqual(['p1', 'p2']);
  });

  // #452: the empty case is now DISABLED up front rather than clickable-then-
  // toasting "Nothing to save" — see the availability specs above.
  it('Download Library as Markdown + SQL name their files from the workspace', () => {
    const app = mount();
    setSaved(app, [{ id: 's1', name: 'A', sql: 'SELECT 1', favorite: false, description: 'd' }]);
    app.state.libraryName.value = 'Lib';
    openFileMenu(app);
    click(item(/Download Library as Markdown/)!);
    expect(app.downloadFile.mock.calls.at(-1)!.slice(0, 2)).toEqual(['Lib.md', 'text/markdown']);
    openFileMenu(app);
    click(item(/Download Library as SQL/)!);
    expect(app.downloadFile.mock.calls.at(-1)!.slice(0, 2)).toEqual(['Lib.sql', 'application/sql']);
    // an unnamed / whitespace-only workspace name falls back to "queries"
    app.state.libraryName.value = '';
    openFileMenu(app);
    click(item(/Download Library as Markdown/)!);
    expect(app.downloadFile.mock.calls.at(-1)![0]).toBe('queries.md');
    app.state.libraryName.value = '   ';
    openFileMenu(app);
    click(item(/Download Library as SQL/)!);
    expect(app.downloadFile.mock.calls.at(-1)![0]).toBe('queries.sql');
  });

  // #427: a document export is the LIBRARY. Each Dashboard member owns a dedicated
  // copy of its query, so exporting the raw collection emitted every panel TWICE,
  // with identical names and SQL. The footer count and the empty gate read the same
  // projection — an all-owned workspace must not offer a download that then toasts
  // "Nothing to save".
  it('Download Markdown/SQL and the count follow the Library projection', () => {
    const app = mount();
    setSaved(app, [
      { id: 'lib', name: 'Standalone', sql: 'SELECT 1', favorite: false },
      { id: 'owned', name: 'Panel copy', sql: 'SELECT 2', favorite: false },
    ]);
    app.state.libraryName.value = 'Lib';
    app.currentWorkspace = {
      storageVersion: 5, id: 'w', key: 'w', name: 'Lib',
      queries: app.state.savedQueries,
      dashboards: [{
        documentVersion: 2, id: 'd1', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
        tiles: [{ id: 't1', queryId: 'owned' }],
      }],
    };
    openFileMenu(app);
    expect(document.querySelector('.fm-count')!.textContent).toBe('1 Library query · 1 dashboard');
    click(item(/Download Library as Markdown/)!);
    const [, , content] = app.downloadFile.mock.calls.at(-1)!;
    expect(content).toContain('Standalone');
    expect(content).not.toContain('Panel copy');
  });

  it('offers no document download when every query is Dashboard-owned', () => {
    const app = mount();
    setSaved(app, [{ id: 'owned', name: 'Panel copy', sql: 'SELECT 2', favorite: false }]);
    app.currentWorkspace = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W',
      queries: app.state.savedQueries,
      dashboards: [{
        documentVersion: 2, id: 'd1', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
        tiles: [{ id: 't1', queryId: 'owned' }],
      }],
    };
    openFileMenu(app);
    expect(document.querySelector('.fm-count')!.textContent).toBe('0 Library queries · 1 dashboard');
    // Disabled up front, not clickable-then-refused: the projection is empty.
    expect(row('Download Library as Markdown').getAttribute('aria-disabled')).toBe('true');
    expect(reasonOf('Download Library as Markdown')).toBe('No Library queries');
    click(row('Download Library as Markdown'));
    expect(app.downloadFile).not.toHaveBeenCalled();
  });
});

describe('Import queries', () => {
  it('the menu item closes the menu, opens the picker, and a picked file imports without a conflict dialog', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'Q1'), panelQuery('q2', 'Q2')] })) });
    app.state.savedQueries = [panelQuery('q1', 'Q1')]; // canonically identical to the incoming q1 → auto-resolved
    openFileMenu(app);
    const input = picker('Import queries…');
    input.click = vi.fn();
    click(item(/Import queries/)!);
    expect(document.querySelector('.file-menu')).toBeNull();
    expect(input.click).toHaveBeenCalled();
    pickFile(input);
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.savedQueries.map((q) => q.id).sort()).toEqual(['q1', 'q2']);
    expect(toast()).toBe('Imported 2 queries');
  });

  it('imports directly (no dialog at all) when no incoming id overlaps an existing one', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('new1'), panelQuery('new2')] })) });
    app.state.savedQueries = [panelQuery('existing')];
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.savedQueries.map((q) => q.id).sort()).toEqual(['existing', 'new1', 'new2']);
  });

  it('picking no file is a no-op', () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1')] })) });
    openFileMenu(app);
    const input = picker('Import queries…');
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.state.savedQueries).toEqual([]);
  });

  it('opens a conflict dialog for genuinely differing ids; the global default resolves an unmarked row', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'NewName')] })) });
    app.state.savedQueries = [panelQuery('q1', 'OldName')];
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    const dialog = document.querySelector('.fm-dialog-card')!;
    expect(dialog.textContent).toContain('Resolve 1 conflicting query');
    expect(dialog.textContent).toContain('OldName'); // row shows the EXISTING query's name
    const shortcut = (keyValue: string, mods: { metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) => ({
      key: keyValue, preventDefault: vi.fn(), target: document.body, ...mods,
    });
    expect(app.keyboardOwner?.kind).toBe('modal');
    expect(handleKeydown(shortcut('Enter', { metaKey: true }), app)).toBeNull();
    expect(handleKeydown(shortcut('s', { metaKey: true }), app)).toBeNull();
    expect(handleKeydown(shortcut('1', { metaKey: true, altKey: true }), app)).toBeNull();
    expect(handleKeydown(shortcut('g'), app)).toBeNull();
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(app.actions.save).not.toHaveBeenCalled();
    expect(app.actions.setEditorMode).not.toHaveBeenCalled();
    app.sqlRoute = { surface: 'dashboard', workspaceKey: app.state.workspaceKey, mode: 'view' };
    const refresh = vi.fn();
    app.surfaceCommands = {
      surface: 'dashboard', generation: 0, refresh, setDashboardStyle: vi.fn(),
      // #426: this spec drives the keyboard command, never member navigation.
      focusMember: () => 'ok',
    };
    expect(handleKeydown(shortcut('Enter', { metaKey: true }), app)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    app.sqlRoute = { surface: 'workspace', workspaceKey: app.state.workspaceKey };
    click(document.querySelector('.fm-dialog-confirm')!); // Apply with the default (use-existing)
    expect(app.keyboardOwner?.kind).toBe('menu'); // the still-mounted File menu remains underneath
    disposeFileMenuOverlays(app);
    expect(app.keyboardOwner).toBeNull();
    await flush();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['OldName']);
    expect(toast()).toBe('Imported 1 query');
  });

  it('a per-row override wins over the global default', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'NewName')] })) });
    app.state.savedQueries = [panelQuery('q1', 'OldName')];
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    const rowSelect = document.querySelectorAll<HTMLSelectElement>('.fm-select')[1]; // [0] is the global select
    rowSelect.value = 'replace';
    rowSelect.dispatchEvent(new Event('change', { bubbles: true }));
    click(document.querySelector('.fm-dialog-confirm')!);
    await flush();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['NewName']);
  });

  it('resetting a row back to "Use default" falls back to the global action', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'NewName')] })) });
    app.state.savedQueries = [panelQuery('q1', 'OldName')];
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    const [globalSelect, rowSelect] = document.querySelectorAll<HTMLSelectElement>('.fm-select');
    globalSelect.value = 'skip';
    globalSelect.dispatchEvent(new Event('change', { bubbles: true }));
    rowSelect.value = 'replace';
    rowSelect.dispatchEvent(new Event('change', { bubbles: true }));
    rowSelect.value = ''; // back to "Use default" — the row no longer overrides
    rowSelect.dispatchEvent(new Event('change', { bubbles: true }));
    click(document.querySelector('.fm-dialog-confirm')!);
    await flush();
    // 'skip' (the global default) dropped the incoming row entirely
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['OldName']);
  });

  it('the global default action applies to every unmarked conflicting row ("copy" keeps both)', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'NewName')] })) });
    app.state.savedQueries = [panelQuery('q1', 'OldName')];
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    const globalSelect = document.querySelector<HTMLSelectElement>('.fm-select')!;
    globalSelect.value = 'copy';
    globalSelect.dispatchEvent(new Event('change', { bubbles: true }));
    click(document.querySelector('.fm-dialog-confirm')!);
    await flush();
    expect(app.state.savedQueries.map((q) => queryName(q)).sort()).toEqual(['NewName', 'OldName']);
    expect(app.state.savedQueries).toHaveLength(2);
  });

  it('"skip" drops the incoming query, leaving the existing one untouched', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'NewName')] })) });
    app.state.savedQueries = [panelQuery('q1', 'OldName')];
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    const globalSelect = document.querySelector<HTMLSelectElement>('.fm-select')!;
    globalSelect.value = 'skip';
    globalSelect.dispatchEvent(new Event('change', { bubbles: true }));
    click(document.querySelector('.fm-dialog-confirm')!);
    await flush();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['OldName']);
    // #344 review 3: the success toast reports what the plan actually did —
    // the one incoming query was skipped, so it must not claim "Imported 1".
    expect(toast()).toBe('Imported 0 queries');
  });

  it('cancelling the conflict dialog aborts the import (no commit)', () => {
    const commit = vi.fn(async (candidate) => ({ ok: true as const, workspace: candidate, dashboardRevision: null }));
    const app = mount({
      FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'NewName')] })),
      workspace: { commit },
    });
    app.state.savedQueries = [panelQuery('q1', 'OldName')];
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    click(document.querySelector('.fm-dialog-cancel')!);
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['OldName']);
  });
});

// Issue tests 4, 10, 11, 14: the MENU ROWS themselves dispatch, against the
// exact Dashboard the surface reported — never a re-read of the session
// selection, which is what used to fall back to the collection's first entry.
describe('Dashboard rows dispatch against the exact target (#452)', () => {
  const wsWithDashboards = (...dashboards: DashboardDocumentV2[]): StoredWorkspaceV5 => ({
    storageVersion: 5, id: 'w', key: 'w', name: 'W',
    queries: [panelQuery('p1', 'Panel')], dashboards,
  });
  /** Point `state.workspaceId` at the fixture aggregate so `mutateWorkspace`'s
   *  `loadById(state.workspaceId)` actually resolves — otherwise `latest` is
   *  `null` and the planner silently falls back to the state-derived snapshot,
   *  which would make the stale-target spec below unfalsifiable. */
  const withActiveId = <T extends App>(app: T): T => {
    app.state.workspaceId = 'w';
    return app;
  };

  it('Export dashboard… exports the exact Dashboard, not the collection’s first', async () => {
    const first = dashboardDoc({ id: 'first', title: 'First' });
    const second = dashboardDoc({ id: 'second', title: 'Second', tiles: [{ id: 't1', queryId: 'p1' }] });
    const committed = wsWithDashboards(first, second);
    const app = mountOn(dashEdit('second'), {
      currentWorkspace: committed,
      workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) },
    });
    openFileMenu(app, dashEdit('second'));
    click(row('Export dashboard…'));
    await flush();
    expect(app.downloadFile.mock.calls[0][0]).toBe('Second.json');
  });

  // #463: exporting from Query with several Dashboards resolves through a
  // chooser — never a silent pick — and the chosen row exports BY ID.
  it('Export dashboard… from Query opens a chooser and exports exactly the chosen one', async () => {
    const first = dashboardDoc({ id: 'first', title: 'First' });
    const second = dashboardDoc({ id: 'second', title: 'Second', tiles: [{ id: 't1', queryId: 'p1' }] });
    const committed = wsWithDashboards(first, second);
    const app = mount({
      currentWorkspace: committed,
      workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) },
    });
    openFileMenu(app);
    click(row('Export dashboard…'));
    const dialog = document.querySelector('.fm-dialog-card')!;
    expect(dialog.textContent).toContain('Export which dashboard?');
    expect(app.downloadFile).not.toHaveBeenCalled();
    click(dialog.querySelector<HTMLButtonElement>('[data-dashboard-id="second"]')!);
    await flush();
    expect(app.downloadFile.mock.calls[0][0]).toBe('Second.json');
  });

  // "the chooser lists Dashboard names and enough secondary identity to
  // distinguish duplicate names" — and picking one still exports BY ID.
  it('the export chooser distinguishes duplicate names and exports the exact id', async () => {
    // Ids deliberately LONGER than the tail the chooser shows, so the assertion
    // fails if the fragment ever widens to the whole id.
    const twinA = dashboardDoc({ id: 'ws-dashboard-aaa111', title: 'Ops', tiles: [{ id: 't1', queryId: 'p1' }] });
    const twinB = dashboardDoc({ id: 'ws-dashboard-bbb222', title: 'Ops' });
    const committed = wsWithDashboards(twinA, twinB);
    const app = mount({
      currentWorkspace: committed,
      workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) },
    });
    openFileMenu(app);
    click(row('Export dashboard…'));
    const dialog = document.querySelector('.fm-dialog-card')!;
    const metas = [...dialog.querySelectorAll('.fm-meta')].map((el) => el.textContent);
    expect(metas).toEqual(['1 tile · aaa111', '0 tiles · bbb222']);
    // The second twin carries no tile, so the exported bundle proves WHICH one.
    click(dialog.querySelector<HTMLButtonElement>('[data-dashboard-id="ws-dashboard-bbb222"]')!);
    await flush();
    const decoded = decodePortableBundleJson(app.downloadFile.mock.calls[0][2] as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.dashboards[0].id).toBe('ws-dashboard-bbb222');
  });

  // P1: a Dashboard id is unique WITHIN a workspace, and an imported workspace
  // keeps the ids it was exported with — so the same id in two workspaces is
  // realistic. The export awaits the write queue, and the user can switch
  // workspace across that await.
  it('refuses to export after the workspace changed mid-flush, even when the id resolves there', async () => {
    const other: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'workspace-b', key: 'b', name: 'B',
      queries: [], dashboards: [dashboardDoc({ id: 'main', title: 'B main' })],
    };
    const mine: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'workspace-a', key: 'a', name: 'A',
      queries: [], dashboards: [dashboardDoc({ id: 'main', title: 'A main' })],
    };
    let released: () => void = () => {};
    const gate = new Promise<void>((resolve) => { released = resolve; });
    const app = mount({
      currentWorkspace: mine,
      // The flush is the await the switch happens across.
      flushWorkspaceWrites: () => gate,
      workspace: {
        loadById: async (id: string) => (
          id === 'workspace-b'
            ? { status: 'ok' as const, workspace: other }
            : { status: 'empty' as const }   // A is gone from this browser
        ),
      },
    });
    app.state.workspaceId = 'workspace-a';
    openFileMenu(app);
    click(row('Export dashboard…'));           // resolves { workspace-a, main }
    app.state.workspaceId = 'workspace-b';     // …and the user moves to B
    app.state.dashboard = other.dashboards[0]; // whose projection has the SAME id
    released();
    await flush();
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toBe('✕ That dashboard is no longer available');
  });

  it('refuses to export the WORKSPACE after the workspace changed mid-flush', async () => {
    let released: () => void = () => {};
    const gate = new Promise<void>((resolve) => { released = resolve; });
    const app = mount({
      flushWorkspaceWrites: () => gate,
      workspace: { loadById: async () => ({ status: 'empty' as const }) },
    });
    app.state.workspaceId = 'workspace-a';
    openFileMenu(app);
    click(row('Export workspace…'));
    app.state.workspaceId = 'workspace-b';
    released();
    await flush();
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toBe('✕ That workspace is no longer available');
  });

  // P1: `state.dashboard` projects the SELECTED Dashboard (#425), which can be
  // any entry. Folding it back through the compatibility slot produced [B, B] —
  // the real first Dashboard dropped and a duplicate id minted — on the very
  // path a user reaches when their storage is failing.
  it('the degraded workspace export keeps every Dashboard when a NON-FIRST one is selected', async () => {
    const a = dashboardDoc({ id: 'a', title: 'Alpha' });
    const b = dashboardDoc({ id: 'b', title: 'Beta' });
    const app = mount({
      currentWorkspace: {
        storageVersion: 5, id: 'w', key: 'w', name: 'Ops', queries: [], dashboards: [a, b],
      },
      // The committed read rejects: blocked/quota/private-mode IndexedDB.
      workspace: { loadById: async () => { throw new Error('idb blocked'); } },
    });
    app.state.workspaceId = 'w';
    app.state.dashboard = b;   // the SECOND entry is the one on screen
    openFileMenu(app);
    click(row('Export workspace…'));
    await flush();
    const decoded = decodePortableBundleJson(app.downloadFile.mock.calls[0][2] as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.dashboards.map((d) => d.id)).toEqual(['a', 'b']);
      expect(decoded.value.dashboards[0]).toEqual(a);
    }
  });

  // The legacy/no-aggregate install: nothing is stored, so the live projection
  // IS the workspace's only Dashboard and has to be seated as such — the one
  // case where there is no committed entry to fold onto.
  it('the degraded export seats the live projection when nothing is stored', async () => {
    const only = dashboardDoc({ id: 'only', title: 'Only' });
    const app = mount({ workspace: { loadById: async () => { throw new Error('idb blocked'); } } });
    app.state.libraryName.value = 'Legacy';
    app.state.dashboard = only;
    openFileMenu(app);
    click(row('Export workspace…'));
    await flush();
    const decoded = decodePortableBundleJson(app.downloadFile.mock.calls[0][2] as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.dashboards.map((d) => d.id)).toEqual(['only']);
  });

  // The live projection still has to WIN over the committed copy on this path —
  // it is the newer of the two — but by exact id, in place.
  it('the degraded export folds the live projection onto its own entry', async () => {
    const b = dashboardDoc({ id: 'b', title: 'Beta' });
    const app = mount({
      currentWorkspace: {
        storageVersion: 5, id: 'w', key: 'w', name: 'Ops', queries: [],
        dashboards: [dashboardDoc({ id: 'a', title: 'Alpha' }), b],
      },
      workspace: { loadById: async () => { throw new Error('idb blocked'); } },
    });
    app.state.workspaceId = 'w';
    app.state.dashboard = { ...b, title: 'Beta (edited)', revision: 9 };
    openFileMenu(app);
    click(row('Export workspace…'));
    await flush();
    const decoded = decodePortableBundleJson(app.downloadFile.mock.calls[0][2] as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.dashboards.map((d) => d.title)).toEqual(['Alpha', 'Beta (edited)']);
    }
  });

  // A projection that names no stored entry is not a slot to guess at: the
  // committed collection is the only trustworthy version left.
  it('the degraded export ignores a projection that names no stored Dashboard', async () => {
    const app = mount({
      currentWorkspace: {
        storageVersion: 5, id: 'w', key: 'w', name: 'Ops', queries: [],
        dashboards: [dashboardDoc({ id: 'a', title: 'Alpha' })],
      },
      workspace: { loadById: async () => { throw new Error('idb blocked'); } },
    });
    app.state.workspaceId = 'w';
    app.state.dashboard = dashboardDoc({ id: 'ghost', title: 'Ghost' });
    openFileMenu(app);
    click(row('Export workspace…'));
    await flush();
    const decoded = decodePortableBundleJson(app.downloadFile.mock.calls[0][2] as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.dashboards.map((d) => d.id)).toEqual(['a']);
  });

  // P2: the bytes were pinned to the source workspace, but the FILE NAME still
  // came from live state — workspace A's contents saved as `B.json`.
  it('names a workspace export after the workspace it exported, not the one now open', async () => {
    const committed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'workspace-a', key: 'a', name: 'Workspace A',
      queries: [panelQuery('q1')], dashboards: [],
    };
    let released: () => void = () => {};
    const gate = new Promise<void>((resolve) => { released = resolve; });
    const app = mount({
      flushWorkspaceWrites: () => gate,
      workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) },
    });
    app.state.workspaceId = 'workspace-a';
    app.state.libraryName.value = 'Workspace A';
    openFileMenu(app);
    click(row('Export workspace…'));
    app.state.workspaceId = 'workspace-b';
    app.state.libraryName.value = 'Workspace B';
    released();
    await flush();
    expect(app.downloadFile.mock.calls[0][0]).toBe('Workspace A.json');
  });

  // An empty Dashboard title is schema-valid, and its file-name fallback is the
  // workspace name — which must be the source workspace's.
  it('names an untitled Dashboard export after its own workspace', async () => {
    const committed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'workspace-a', key: 'a', name: 'Workspace A',
      queries: [], dashboards: [dashboardDoc({ id: 'only', title: '' })],
    };
    const app = mount({
      currentWorkspace: committed,
      workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) },
    });
    app.state.workspaceId = 'workspace-a';
    app.state.libraryName.value = 'Workspace A';
    openFileMenu(app);
    click(row('Export dashboard…'));
    await flush();
    expect(app.downloadFile.mock.calls[0][0]).toBe('Workspace A.json');
  });

  // …and on the degraded path the pinned name is the only one available.
  it('names an untitled Dashboard export after its workspace on the degraded path too', async () => {
    const untitled = dashboardDoc({ id: 'only', title: '' });
    const app = mount({ workspace: { loadById: async () => { throw new Error('idb blocked'); } } });
    app.state.workspaceId = 'workspace-a';
    app.state.libraryName.value = 'Workspace A';
    app.state.dashboard = untitled;
    app.currentWorkspace = {
      storageVersion: 5, id: 'workspace-a', key: 'a', name: 'Workspace A',
      queries: [], dashboards: [untitled],
    };
    openFileMenu(app);
    click(row('Export dashboard…'));
    await flush();
    expect(app.downloadFile.mock.calls[0][0]).toBe('Workspace A.json');
  });

  // P2: the menu's decision is made when it OPENS, and nothing closes it when a
  // background commit lands. A `choose` target whose Dashboards are all gone
  // used to open a chooser with no rows — and then throw focusing row zero.
  it('re-resolves the export target on activation instead of opening an empty chooser', async () => {
    // Both aliased to the interface: an inline literal narrows
    // `app.currentWorkspace` to its own shape and refuses the later assignment.
    const before: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [],
      dashboards: [dashboardDoc({ id: 'a' }), dashboardDoc({ id: 'b' })],
    };
    const emptied: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [], dashboards: [],
    };
    const app = mount({ currentWorkspace: before });
    openFileMenu(app);
    expect(reasonOf('Export dashboard…')).toBeNull();   // enabled: two Dashboards
    // Another tab removes both, projecting a new workspace under the open menu.
    app.currentWorkspace = emptied;
    expect(() => click(row('Export dashboard…'))).not.toThrow();
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toBe('✕ That dashboard is no longer available');
  });

  // The same re-resolution narrows `choose` to `exact` when the collection drops
  // to one — no chooser for a workspace with a single answer.
  it('re-resolves a narrowed collection straight to its sole Dashboard', async () => {
    const survivor = dashboardDoc({ id: 'b', title: 'Survivor' });
    const shrunk: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [], dashboards: [survivor],
    };
    const before: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [],
      dashboards: [dashboardDoc({ id: 'a' }), survivor],
    };
    const app = mount({
      currentWorkspace: before,
      workspace: { loadById: async () => ({ status: 'ok' as const, workspace: shrunk }) },
    });
    openFileMenu(app);
    app.currentWorkspace = shrunk;
    click(row('Export dashboard…'));
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.downloadFile.mock.calls[0][0]).toBe('Survivor.json');
  });

  it('cancelling the export chooser downloads nothing', () => {
    const committed = wsWithDashboards(dashboardDoc({ id: 'a' }), dashboardDoc({ id: 'b' }));
    const app = mount({ currentWorkspace: committed });
    openFileMenu(app);
    click(row('Export dashboard…'));
    click(document.querySelector('.fm-dialog-cancel')!);
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.downloadFile).not.toHaveBeenCalled();
  });

  // A sole Dashboard has exactly one answer, so Query exports it with no
  // chooser — resolved by id, not by being `dashboards[0]`.
  it('Export dashboard… from Query exports the sole Dashboard directly', async () => {
    const committed = wsWithDashboards(dashboardDoc({ id: 'only', title: 'Only', tiles: [{ id: 't1', queryId: 'p1' }] }));
    const app = mount({
      currentWorkspace: committed,
      workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) },
    });
    openFileMenu(app);
    click(row('Export dashboard…'));
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.downloadFile.mock.calls[0][0]).toBe('Only.json');
  });

  // #463: the import APPENDS. Both stored Dashboards survive, in order, and no
  // confirm gate stands in front of an operation that cannot lose anything.
  it('Import dashboard… appends beside every existing Dashboard, with no confirm', async () => {
    const committed = wsWithDashboards(
      dashboardDoc({ id: 'first', title: 'First' }), dashboardDoc({ id: 'second', title: 'Second' }),
    );
    const incoming = dashboardDoc({ id: 'src', title: 'Incoming' });
    const app = withActiveId(mountOn(dashEdit('second'), {
      currentWorkspace: committed,
      FileReader: fakeReader(bundleText({ dashboards: [incoming] })),
      workspace: statefulWorkspaceRepo(committed),
    }));
    app.openDashboard = vi.fn();
    openFileMenu(app, dashEdit('second'));
    const input = picker('Import dashboard…');
    input.click = vi.fn();
    click(row('Import dashboard…'));
    expect(input.click).toHaveBeenCalled();
    pickFile(input);
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    const saved = await loadActiveWorkspace(app);
    expect(saved.dashboards.map((d) => d.title)).toEqual(['First', 'Second', 'Incoming']);
    // An append is invisible otherwise: the new Dashboard lands last, in a
    // collection the user may not have open. Opening it is what separates a
    // successful additive import from a silent no-op.
    expect(app.openDashboard).toHaveBeenCalledWith({ dashboardId: saved.dashboards[2].id, mode: 'edit' });
    expect(app.state.upperRole.value).toBe('dashboards');
    // The Dashboard that was OPEN is byte-identical — the import did not merge
    // into it, and the reminted id proves the appended entry is a new document.
    expect(saved.dashboards[1]).toEqual(committed.dashboards[1]);
    expect(saved.dashboards[2].id).not.toBe('src');
  });

  // The window #452 had to fail closed on: a Dashboard seated between the menu
  // opening and the commit landing. An append has no target to invalidate, so
  // the import now succeeds beside it instead of aborting.
  it('a Dashboard seated while the file chooser is open no longer blocks the import', async () => {
    const empty: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [], dashboards: [],
    };
    const repo = statefulWorkspaceRepo(empty);
    const app = withActiveId(mountOn(dashEdit(null), {
      currentWorkspace: empty,
      FileReader: fakeReader(bundleText({ dashboards: [dashboardDoc({ id: 'src', title: 'Incoming' })] })),
      workspace: repo,
    }));
    openFileMenu(app, dashEdit(null));
    const input = picker('Import dashboard…');
    click(row('Import dashboard…'));
    // A Dashboard appears while the native file chooser is still open.
    await repo.commit({ ...empty, dashboards: [dashboardDoc({ id: 'seated', title: 'Seated first' })] });
    pickFile(input);
    await flush();
    expect(toast()).toBe('Imported dashboard');
    const saved = await loadActiveWorkspace(app);
    // Both survive, and the one that arrived in the window kept its place.
    expect(saved.dashboards.map((d) => d.title)).toEqual(['Seated first', 'Incoming']);
  });

  // The Dashboard on screen being DELETED mid-flight used to abort the import
  // (it was the target). It is not a target any more, so the import lands.
  it('an import outlives the deletion of the Dashboard it was started from', async () => {
    const committed = wsWithDashboards(
      dashboardDoc({ id: 'other', title: 'Other' }), dashboardDoc({ id: 'doomed', title: 'Doomed' }),
    );
    const repo = statefulWorkspaceRepo(committed);
    const app = withActiveId(mountOn(dashEdit('doomed'), {
      currentWorkspace: committed,
      FileReader: fakeReader(bundleText({ dashboards: [dashboardDoc({ id: 'src', title: 'Incoming' })] })),
      workspace: repo,
    }));
    openFileMenu(app, dashEdit('doomed'));
    const input = picker('Import dashboard…');
    click(row('Import dashboard…'));
    // The Dashboard the menu was opened from disappears.
    await repo.commit({ ...committed, dashboards: [committed.dashboards[0]] });
    pickFile(input);
    await flush();
    const saved = await loadActiveWorkspace(app);
    expect(saved.dashboards.map((d) => d.title)).toEqual(['Other', 'Incoming']);
  });
});

describe('Import dashboard', () => {
  // #463: additive on every surface, including Query — no open Dashboard, no
  // target, no confirm.
  it('the menu row opens a hidden picker; a single-dashboard file imports directly, minting a fresh id/revision', async () => {
    const dep = panelQuery('p1', 'Panel');
    const dash = dashboardDoc({ id: 'src-d', title: 'Sales', tiles: [{ id: 't1', queryId: 'p1' }] });
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [dep], dashboards: [dash] })) });
    openFileMenu(app);
    const input = picker('Import dashboard…');
    expect(input.style.display).toBe('none');
    input.click = vi.fn();
    click(row('Import dashboard…'));
    expect(input.click).toHaveBeenCalled();
    pickFile(input);
    await flush();
    // Nothing is replaced, so nothing is confirmed.
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.dashboard).not.toBeNull();
    expect(app.state.dashboard!.id).not.toBe('src-d'); // the id is always reminted
    expect(app.state.dashboard!.revision).toBe(1);
    expect(app.state.dashboard!.title).toBe('Sales');
    expect(app.state.savedQueries.map((q) => q.id)).toContain('p1');
    expect(toast()).toBe('Imported dashboard');
  });

  // Acceptance: "Existing Dashboards and Library queries are never overwritten
  // by implicit fallback behaviour." Driven from the surface that used to be the
  // most dangerous one — an open Dashboard, which the import used to replace.
  it('preserves the existing Dashboards byte-for-byte, importing from Dashboard View', async () => {
    const committed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W',
      queries: [panelQuery('lib', 'Library query')],
      dashboards: [dashboardDoc({ id: 'keep-a', title: 'Keep A' }), dashboardDoc({ id: 'keep-b', title: 'Keep B' })],
    };
    const app = mountOn(dashView('keep-a'), {
      currentWorkspace: committed,
      FileReader: fakeReader(bundleText({ dashboards: [dashboardDoc({ id: 'src', title: 'Added' })] })),
      workspace: statefulWorkspaceRepo(committed),
    });
    app.state.workspaceId = 'w';
    pickDashboardImport(app, dashView('keep-a'));
    await flush();
    const saved = await loadActiveWorkspace(app);
    expect(saved.dashboards.slice(0, 2)).toEqual(committed.dashboards);
    expect(saved.dashboards[2].title).toBe('Added');
    // The Library query is untouched too.
    expect(saved.queries.map((q) => q.id)).toContain('lib');
  });

  it('shows a picker (no "No dashboard" option) for a multi-dashboard bundle; selecting one imports only that one', async () => {
    const dep1 = panelQuery('p1', 'Panel1');
    const dep2 = panelQuery('p2', 'Panel2');
    const dashA = dashboardDoc({ id: 'a', title: 'Alpha', tiles: [{ id: 't1', queryId: 'p1' }] });
    const dashB = dashboardDoc({ id: 'b', title: 'Beta', tiles: [{ id: 't2', queryId: 'p2' }] });
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [dep1, dep2], dashboards: [dashA, dashB] })) });
    pickDashboardImport(app);
    const dialog = document.querySelector('.fm-dialog-card')!;
    expect(dialog.textContent).toContain('Import which dashboard?');
    expect(dialog.textContent).toContain('Alpha');
    expect(dialog.textContent).toContain('Beta');
    expect([...dialog.querySelectorAll('.fm-label')].some((l) => l.textContent === 'No dashboard')).toBe(false);
    const betaRow = [...dialog.querySelectorAll<HTMLButtonElement>('.fm-item')].find((b) => (b.textContent || '').includes('Beta'))!;
    click(betaRow);
    await flush();
    expect(app.state.dashboard!.title).toBe('Beta');
    expect(app.state.savedQueries.map((q) => q.id)).toContain('p2');
  });

  // P2: a chooser reached from a keyboard-driven menu row must not leave the
  // user behind the modal.
  it('focuses the first Dashboard row, so Enter picks it', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({
      dashboards: [dashboardDoc({ id: 'a', title: 'Alpha' }), dashboardDoc({ id: 'b', title: 'Beta' })],
    })) });
    pickDashboardImport(app);
    await flush();
    const first = document.querySelector('.fm-picker-list .fm-item');
    expect(document.activeElement).toBe(first);
    click(first!);
    await flush();
    expect(app.state.dashboard!.title).toBe('Alpha');
  });

  // The shell mounts a modal but nothing makes the page behind it unreachable,
  // so Tab has to wrap inside the card rather than walk out of it.
  it('keeps Tab inside the dialog', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({
      dashboards: [dashboardDoc({ id: 'a', title: 'Alpha' }), dashboardDoc({ id: 'b', title: 'Beta' })],
    })) });
    pickDashboardImport(app);
    await flush();
    const items = [...document.querySelectorAll<HTMLElement>('.fm-dialog-card button')];
    const [first] = items;
    const last = items[items.length - 1];      // Cancel
    expect(document.activeElement).toBe(first);

    // Shift+Tab off the front wraps to the back…
    key(document, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    // …Tab off the back wraps to the front…
    key(document, 'Tab');
    expect(document.activeElement).toBe(first);
    // …a Tab in the middle is left to the browser…
    items[1].focus();
    const middle = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(items[1]);
    // …and a Tab from OUTSIDE the card is pulled back in.
    app.dom.fileBtn!.focus();
    key(document, 'Tab');
    expect(document.activeElement).toBe(first);
  });

  it('cancelling the multi-dashboard picker imports nothing', () => {
    const dashA = dashboardDoc({ id: 'a', title: 'Alpha' });
    const dashB = dashboardDoc({ id: 'b', title: 'Beta' });
    const app = mount({ FileReader: fakeReader(bundleText({ dashboards: [dashA, dashB] })) });
    pickDashboardImport(app);
    click(document.querySelector('.fm-dialog-cancel')!);
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.dashboard).toBeNull();
  });

  it('dismisses the multi-dashboard picker on Escape', () => {
    const dashA = dashboardDoc({ id: 'a', title: 'Alpha' });
    const dashB = dashboardDoc({ id: 'b', title: 'Beta' });
    const app = mount({ FileReader: fakeReader(bundleText({ dashboards: [dashA, dashB] })) });
    pickDashboardImport(app);
    expect(document.querySelector('.fm-dialog-card')).not.toBeNull();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.dashboard).toBeNull();
  });

  it('aborts (no commit) when a skipped conflict breaks a required tile dependency', async () => {
    const dash = dashboardDoc({ id: 'src', title: 'D', tiles: [{ id: 't1', queryId: 'p1' }] });
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('p1', 'Incoming')], dashboards: [dash] })) });
    app.state.savedQueries = [panelQuery('p1', 'Existing')]; // conflicting id, different content
    pickDashboardImport(app);
    const rowSelect = document.querySelectorAll<HTMLSelectElement>('.fm-select')[1];
    rowSelect.value = 'skip';
    rowSelect.dispatchEvent(new Event('change', { bubbles: true }));
    click(document.querySelector('.fm-dialog-confirm')!);
    await flush();
    expect(app.state.dashboard).toBeNull();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['Existing']);
    expect(toast()).toContain('missing required saved-query dependencies');
  });

  it('toasts and aborts when the file has no dashboard', () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [] })) });
    pickDashboardImport(app);
    expect(toast()).toBe('✕ No dashboard in file');
  });
});

describe('Import example dashboard (#506)', () => {
  it('lists exactly the manifest entries, in manifest order, using their stored names', () => {
    const app = mount();
    const dialog = openExampleDialog(app);
    expect(dialog.textContent).toContain('Import example dashboard');
    const radios = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((b) => b.textContent)).toEqual(EXAMPLE_DASHBOARDS.map((e) => e.name));
    expect(dialog.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it('Import starts disabled with no selection', () => {
    const app = mount();
    openExampleDialog(app);
    const confirm = document.querySelector<HTMLButtonElement>('.fm-dialog-confirm')!;
    expect(confirm.disabled).toBe(true);
  });

  it('selecting a row enables Import and marks exactly that row aria-checked', () => {
    const app = mount();
    openExampleDialog(app);
    const confirm = document.querySelector<HTMLButtonElement>('.fm-dialog-confirm')!;
    const [first, second] = EXAMPLE_DASHBOARDS.map((e) => e.name);
    click(exampleRadio(first));
    expect(confirm.disabled).toBe(false);
    expect(exampleRadio(first).getAttribute('aria-checked')).toBe('true');
    expect(exampleRadio(second).getAttribute('aria-checked')).toBe('false');
    // Selecting a second row moves the mark rather than adding to it.
    click(exampleRadio(second));
    expect(exampleRadio(first).getAttribute('aria-checked')).toBe('false');
    expect(exampleRadio(second).getAttribute('aria-checked')).toBe('true');
    expect(confirm.disabled).toBe(false);
  });

  it('Cancel, Escape, and an outside click all leave the workspace unchanged', () => {
    for (const dismiss of [
      () => click(document.querySelector('.fm-dialog-cancel')!),
      () => key(document, 'Escape'),
      // `attachBackdropClose` only closes on a press that STARTED on the
      // backdrop, so a bare click is not the gesture.
      () => {
        const backdrop = document.querySelector('.fm-dialog-backdrop')!;
        backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        click(backdrop);
      },
    ]) {
      document.body.replaceChildren();
      const app = mount();
      openExampleDialog(app);
      click(exampleRadio(EXAMPLE_DASHBOARDS[0].name));
      dismiss();
      expect(document.querySelector('.fm-dialog-card')).toBeNull();
      expect(app.state.dashboard).toBeNull();
    }
  });

  it('Import decodes the selected example through the SAME additive pipeline a file import uses, then opens it', async () => {
    const shop = EXAMPLE_DASHBOARDS.find((e) => e.file === 'shop-charts.json')!;
    const app = mount();
    app.openDashboard = vi.fn();
    openExampleDialog(app);
    click(exampleRadio(shop.name));
    click(document.querySelector('.fm-dialog-confirm')!);
    expect(document.querySelector('.fm-dialog-card')).toBeNull(); // closes immediately, like the file picker
    await flush();
    expect(toast()).toBe('Imported dashboard');
    expect(app.state.dashboard).not.toBeNull();
    expect(app.state.dashboard!.title).toBe('Shop analytics'); // the bundle Dashboard's own title, not the catalogue's display name
    expect(app.state.dashboard!.id).not.toBe('shop-analytics'); // reminted, like a file import
    expect(app.state.savedQueries.length).toBeGreaterThan(0);
    expect(app.state.upperRole.value).toBe('dashboards');
  });

  // Acceptance: "An existing Dashboard is never silently replaced or merged."
  it('appends beside every existing Dashboard, with no confirm', async () => {
    const shop = EXAMPLE_DASHBOARDS.find((e) => e.file === 'shop-charts.json')!;
    const committed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W',
      queries: [], dashboards: [dashboardDoc({ id: 'first', title: 'First' })],
    };
    const app = mountOn(dashEdit('first'), {
      currentWorkspace: committed,
      workspace: statefulWorkspaceRepo(committed),
    });
    app.state.workspaceId = 'w';
    openExampleDialog(app, dashEdit('first'));
    click(exampleRadio(shop.name));
    click(document.querySelector('.fm-dialog-confirm')!);
    await flush();
    const saved = await loadActiveWorkspace(app);
    expect(saved.dashboards.map((d) => d.title)).toEqual(['First', 'Shop analytics']);
    expect(saved.dashboards[0]).toEqual(committed.dashboards[0]);
  });

  // A build-time-validated example should always decode, but the wiring must
  // fail the same safe way a corrupt FILE would (#506 acceptance: "malformed
  // example… reports an error and leaves the workspace unchanged") — asserted
  // directly against the exported action, independent of the dialog.
  it('a malformed embedded example toasts and leaves the workspace unchanged', () => {
    const app = mount();
    startImportExampleDashboard(app, { file: 'bad.json', name: 'Bad', json: 'not json' });
    expect(toast()).toContain('✕');
    expect(app.state.dashboard).toBeNull();
  });
});

describe('afterLibraryChange — dashboard route (#302)', () => {
  it('on the dashboard route, a commit reloads the dashboard route and skips the Workbench repaint', async () => {
    const dep = panelQuery('p1', 'Panel');
    const dash = dashboardDoc({ id: 'src-d', title: 'Sales', tiles: [{ id: 't1', queryId: 'p1' }] });
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [dep], dashboards: [dash] })) });
    app.sqlRoute = { surface: 'dashboard', workspaceKey: app.state.workspaceKey, mode: 'edit' };
    app.reloadDashboardRoute = vi.fn();
    pickDashboardImport(app);
    await flush();
    expect(app.reloadDashboardRoute).toHaveBeenCalled();
    expect(app.state.dashboard).not.toBeNull(); // the commit itself still landed
    expect(app.updateSaveBtn).not.toHaveBeenCalled();
    expect(app.updateEditorModeUi).not.toHaveBeenCalled();
  });
});

describe('Import workspace (#406 additive collection)', () => {
  it('the menu item closes the menu, opens the picker, and creates a fresh active workspace', async () => {
    const dep = panelQuery('p1', 'Panel');
    const dash = dashboardDoc({ id: 'd1', title: 'Ops', tiles: [{ id: 't1', queryId: 'p1' }] });
    const create = vi.fn(async (workspace: StoredWorkspaceV5) => ({
      ok: true as const, workspace, dashboardRevision: workspace.dashboards[0]?.revision ?? null,
    }));
    const app = mount({
      FileReader: fakeReader(bundleText({
        metadata: { name: 'Imported Ops' }, queries: [dep], dashboards: [dash],
      })),
      workspace: {
        create,
        list: async () => ({
          summaries: [{
            id: 'existing', key: 'imported_ops', name: 'Existing',
            queryCount: 0, hasDashboard: false, lastOpenedAt: null,
          }],
          corrupt: [{ id: 'broken', key: 'imported_ops_2', diagnostics: [] }],
        }),
      },
    });
    app.rewriteWorkspaceRoute = vi.fn();
    app.state.savedQueries = [panelQuery('old', 'Old')];
    const oldId = app.state.workspaceId;
    openFileMenu(app);
    const input = picker('Import workspace…');
    input.click = vi.fn();
    click(item(/Import workspace/)!);
    expect(document.querySelector('.file-menu')).toBeNull();
    expect(input.click).toHaveBeenCalled();
    pickFile(input);
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      storageVersion: 5, key: 'imported_ops_3', name: 'Imported Ops',
    });
    expect(create.mock.calls[0][0].id).not.toBe(oldId);
    // #427: the bundle's query lands as the Library source and the imported
    // tile gets its own dedicated copy, so the collection holds both.
    expect(app.state.savedQueries.map((q) => q.id)[0]).toBe('p1');
    expect(app.state.savedQueries).toHaveLength(2);
    expect(app.state.dashboard!.id).toBe('d1');
    expect(app.state.dashboard!.tiles[0].queryId).not.toBe('p1');
    expect(app.rewriteWorkspaceRoute).toHaveBeenCalledWith('imported_ops_3');
    expect(toast()).toBe('Imported workspace');
  });

  // #424: a workspace import now takes the bundle WHOLE — there is no "which
  // dashboard?" picker any more, and EVERY bundled Dashboard lands in the new
  // workspace's collection, in bundle order (the first becomes the
  // compatibility Dashboard the current single-surface UI shows/edits).
  it('imports every bundled Dashboard directly, in bundle order, with no picker', async () => {
    const dashA = dashboardDoc({ id: 'a', title: 'Alpha' });
    const dashB = dashboardDoc({ id: 'b', title: 'Beta' });
    const create = vi.fn(async (workspace: StoredWorkspaceV5) => ({
      ok: true as const, workspace, dashboardRevision: workspace.dashboards[0]?.revision ?? null,
    }));
    const app = mount({
      FileReader: fakeReader(bundleText({ dashboards: [dashA, dashB] })),
      workspace: { create },
    });
    app.state.dashboard = dashboardDoc({ id: 'existing', title: 'Existing' });
    openFileMenu(app);
    pickFile(picker('Import workspace…'));
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].dashboards.map((d: DashboardDocumentV2) => d.title)).toEqual(['Alpha', 'Beta']);
    expect(app.state.dashboard?.title).toBe('Alpha'); // compatibility slot = dashboards[0]
  });

  it('auto-picks the sole Dashboard in a single-dashboard bundle (no picker)', async () => {
    const dash = dashboardDoc({ id: 'only', title: 'Only' });
    const app = mount({ FileReader: fakeReader(bundleText({ dashboards: [dash] })) });
    openFileMenu(app);
    pickFile(picker('Import workspace…'));
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.dashboard?.id).toBe('only');
  });

  it('warns when an imported workspace is active but last-used metadata cannot be saved', async () => {
    const app = mount({
      FileReader: fakeReader(bundleText({ queries: [panelQuery('q1')] })),
      workspace: {
        markOpened: async () => ({
          ok: false as const,
          diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'blocked' }],
        }),
      },
    });
    openFileMenu(app);
    pickFile(picker('Import workspace…'));
    await app.flushWorkspaceWrites();
    await flush();
    expect(app.state.savedQueries.map((query) => query.id)).toEqual(['q1']);
    expect(toast()).toBe('Imported workspace, but its last-used timestamp could not be saved.');
  });

  it('a queries-only bundle creates a workspace without a Dashboard', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('p1')] })) });
    app.state.dashboard = dashboardDoc({ id: 'existing', title: 'Existing' });
    app.state.savedQueries = [];
    openFileMenu(app);
    pickFile(picker('Import workspace…'));
    await flush();
    expect(app.state.dashboard).toBeNull();
    expect(app.state.savedQueries.map((q) => q.id)).toEqual(['p1']);
  });
});

describe('New workspace', () => {
  it('commits directly (no confirm) when the workspace is already empty', async () => {
    const app = mount({
      workspace: {
        list: async () => ({
          summaries: [{
            id: 'existing', key: 'sql_library', name: 'Existing',
            queryCount: 0, hasDashboard: false, lastOpenedAt: null,
          }],
          corrupt: [{ id: 'broken', key: 'sql_library_2', diagnostics: [] }],
        }),
      },
    });
    app.rewriteWorkspaceRoute = vi.fn();
    const oldId = app.state.workspaceId;
    openFileMenu(app);
    click(item(/New workspace/)!);
    await flush();
    expect(document.querySelector('.fm-dialog-backdrop')).toBeNull();
    expect(app.state.savedQueries).toEqual([]);
    expect(app.state.libraryName.value).toBe('SQL Library');
    expect(app.state.workspaceKey).toBe('sql_library_3');
    expect(app.state.workspaceId).not.toBe(oldId);
    expect(app.rewriteWorkspaceRoute).toHaveBeenCalledWith('sql_library_3');
    expect(toast()).toBe('Started a new workspace');
  });

  it('creates additively without confirmation when there are saved queries', async () => {
    const app = mount();
    app.state.savedQueries = [panelQuery('q1')];
    openFileMenu(app);
    click(item(/New workspace/)!);
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.savedQueries).toEqual([]);
  });

  it('creates additively without confirmation when a Dashboard exists', async () => {
    const app = mount();
    app.state.dashboard = dashboardDoc();
    openFileMenu(app);
    click(item(/New workspace/)!);
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.dashboard).toBeNull();
  });

  it('warns when a new workspace is active but last-used metadata cannot be saved', async () => {
    const app = mount({
      workspace: {
        markOpened: async () => ({
          ok: false as const,
          diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'blocked' }],
        }),
      },
    });
    openFileMenu(app);
    click(item(/New workspace/)!);
    await app.flushWorkspaceWrites();
    await flush();
    expect(app.state.libraryName.value).toBe('SQL Library');
    expect(toast()).toBe('Started a new workspace, but its last-used timestamp could not be saved.');
  });
});

describe('New dashboard (#463)', () => {
  const wsWith = (...dashboards: DashboardDocumentV2[]): StoredWorkspaceV5 => ({
    storageVersion: 5, id: 'w', key: 'w', name: 'W',
    queries: [panelQuery('lib', 'Library query')], dashboards,
  });
  /** Mount with a real repository behind an id `mutateWorkspace` can load, and
   *  a spy on the one navigation this flow performs. */
  const mountWith = (committed: StoredWorkspaceV5, context?: FileMenuSurfaceContext) => {
    const app = context
      ? mountOn(context, { currentWorkspace: committed, workspace: statefulWorkspaceRepo(committed) })
      : mount({ currentWorkspace: committed, workspace: statefulWorkspaceRepo(committed) });
    app.state.workspaceId = 'w';
    app.openDashboard = vi.fn();
    return app;
  };
  /** Open the menu, click New dashboard…, and answer its name prompt. */
  const create = (app: App, name: string | null, context?: FileMenuSurfaceContext): void => {
    openFileMenu(app, context);
    click(row('New dashboard…'));
    const input = document.querySelector<HTMLInputElement>('.fm-dialog-input')!;
    if (name !== null) {
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    click(document.querySelector('.fm-dialog-confirm')!);
  };

  it('prompts for a name, defaulting to Dashboard, before committing anything', async () => {
    const app = mountWith(wsWith());
    openFileMenu(app);
    click(row('New dashboard…'));
    const card = document.querySelector('.fm-dialog-card')!;
    expect(card.textContent).toContain('New dashboard');
    const input = card.querySelector<HTMLInputElement>('.fm-dialog-input')!;
    expect(input.value).toBe('Dashboard');
    expect(card.querySelector('label')!.getAttribute('for')).toBe(input.id);
    await flush();
    // Nothing is committed until the prompt is answered.
    expect((await loadActiveWorkspace(app)).dashboards).toEqual([]);
  });

  it('appends the named Dashboard and opens it in Edit mode', async () => {
    const existing = dashboardDoc({ id: 'keep', title: 'Keep' });
    const app = mountWith(wsWith(existing));
    create(app, 'Ingest health');
    await flush();
    const saved = await loadActiveWorkspace(app);
    expect(saved.dashboards.map((d) => d.title)).toEqual(['Keep', 'Ingest health']);
    // The existing Dashboard and the Library are untouched.
    expect(saved.dashboards[0]).toEqual(existing);
    expect(saved.queries.map((q) => q.id)).toEqual(['lib']);
    // Empty: no tile, no variable configuration, no saved query of its own.
    expect(saved.dashboards[1].tiles).toEqual([]);
    expect(saved.dashboards[1].variableConfigs).toBeUndefined();
    expect(saved.dashboards[1].revision).toBe(1);
    expect(app.openDashboard).toHaveBeenCalledWith({ dashboardId: saved.dashboards[1].id, mode: 'edit' });
    // Owner feedback: opening the surface is only half the switch — the upper
    // sidebar has to show the Dashboards tree, or the Dashboard you just made is
    // on screen while the list that marks it selected stays behind the other tab.
    expect(app.state.upperRole.value).toBe('dashboards');
    expect(toast()).toBe('Created dashboard');
  });

  it('leaves the sidebar alone when the commit is refused', async () => {
    const committed = wsWith();
    const repo = statefulWorkspaceRepo(committed);
    const app = mount({
      currentWorkspace: committed,
      workspace: {
        ...repo,
        commit: async () => ({
          ok: false as const,
          diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'nope' }],
        }),
      },
    });
    app.state.workspaceId = 'w';
    app.openDashboard = vi.fn();
    expect(app.state.upperRole.value).toBe('databases');
    create(app, 'Doomed');
    await flush();
    expect(app.state.upperRole.value).toBe('databases');
  });

  it('trims the name', async () => {
    const app = mountWith(wsWith());
    create(app, '  Spaced  ');
    await flush();
    expect((await loadActiveWorkspace(app)).dashboards[0].title).toBe('Spaced');
  });

  // Duplicate display names are allowed; identity is the id.
  it('allows a duplicate name, under a distinct id', async () => {
    const app = mountWith(wsWith(dashboardDoc({ id: 'first', title: 'Ops' })));
    create(app, 'Ops');
    await flush();
    const saved = await loadActiveWorkspace(app);
    expect(saved.dashboards.map((d) => d.title)).toEqual(['Ops', 'Ops']);
    expect(saved.dashboards[1].id).not.toBe('first');
  });

  it('refuses a whitespace-only name rather than committing an untitled Dashboard', async () => {
    const app = mountWith(wsWith());
    openFileMenu(app);
    click(row('New dashboard…'));
    const input = document.querySelector<HTMLInputElement>('.fm-dialog-input')!;
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const confirm = document.querySelector<HTMLButtonElement>('.fm-dialog-confirm')!;
    expect(confirm.disabled).toBe(true);
    click(confirm);
    key(input, 'Enter');
    await flush();
    // Still open, nothing committed.
    expect(document.querySelector('.fm-dialog-card')).not.toBeNull();
    expect((await loadActiveWorkspace(app)).dashboards).toEqual([]);
  });

  it('commits on Enter in the name field', async () => {
    const app = mountWith(wsWith());
    openFileMenu(app);
    click(row('New dashboard…'));
    const input = document.querySelector<HTMLInputElement>('.fm-dialog-input')!;
    input.value = 'Typed';
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect((await loadActiveWorkspace(app)).dashboards.map((d) => d.title)).toEqual(['Typed']);
  });

  // No aggregate resolves for `state.workspaceId`, so the builder is handed
  // `latest: null` and the append falls back to the `state`-derived workspace —
  // the same `latest ?? currentWorkspace(app)` fallback every commit in this
  // module carries for the legacy/first-run install.
  it('creates the first Dashboard of a workspace with no persisted aggregate', async () => {
    const app = mount({ workspace: statefulWorkspaceRepo(null) });
    app.state.savedQueries = [panelQuery('lib', 'Library query')];
    app.openDashboard = vi.fn();
    create(app, 'Bootstrapped');
    await flush();
    const saved = await loadActiveWorkspace(app);
    expect(saved.dashboards.map((d) => d.title)).toEqual(['Bootstrapped']);
    expect(saved.queries.map((q) => q.id)).toEqual(['lib']);
    expect(app.openDashboard).toHaveBeenCalledWith({ dashboardId: saved.dashboards[0].id, mode: 'edit' });
  });

  it('ignores an ordinary keystroke in the name field', async () => {
    const app = mountWith(wsWith());
    openFileMenu(app);
    click(row('New dashboard…'));
    const input = document.querySelector<HTMLInputElement>('.fm-dialog-input')!;
    key(input, 'a');
    await flush();
    expect(document.querySelector('.fm-dialog-card')).not.toBeNull();
    expect((await loadActiveWorkspace(app)).dashboards).toEqual([]);
  });

  it('commits nothing on Cancel', async () => {
    const app = mountWith(wsWith());
    openFileMenu(app);
    click(row('New dashboard…'));
    click(document.querySelector('.fm-dialog-cancel')!);
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect((await loadActiveWorkspace(app)).dashboards).toEqual([]);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('commits nothing on Escape', async () => {
    const app = mountWith(wsWith());
    openFileMenu(app);
    click(row('New dashboard…'));
    key(document, 'Escape');
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect((await loadActiveWorkspace(app)).dashboards).toEqual([]);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  // A failed commit leaves navigation and local state unchanged, and surfaces
  // the diagnostic.
  it('surfaces a rejected commit and does not navigate', async () => {
    const committed = wsWith();
    const repo = statefulWorkspaceRepo(committed);
    const app = mount({
      currentWorkspace: committed,
      workspace: {
        ...repo,
        commit: async () => ({
          ok: false as const,
          diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'Quota exceeded' }],
        }),
      },
    });
    app.state.workspaceId = 'w';
    app.openDashboard = vi.fn();
    create(app, 'Doomed');
    await flush();
    expect(toast()).toBe('✕ Quota exceeded');
    expect(app.openDashboard).not.toHaveBeenCalled();
    expect((await loadActiveWorkspace(app)).dashboards).toEqual([]);
  });

  // Creation opens the new Dashboard in Edit mode, so View mode is not a bar.
  it('is available from Dashboard View mode', async () => {
    const app = mountWith(wsWith(dashboardDoc({ id: 'seen' })), dashView('seen'));
    create(app, 'From view', dashView('seen'));
    await flush();
    const saved = await loadActiveWorkspace(app);
    expect(saved.dashboards.map((d) => d.title)).toEqual(['D', 'From view']);
    expect(app.openDashboard).toHaveBeenCalledWith({ dashboardId: saved.dashboards[1].id, mode: 'edit' });
  });

  // The issue's Tests list: "keyboard operation, focus return, Escape, and
  // outside-click dismissal". The row click closes the menu (which returns focus
  // to the File trigger), then the dialog takes it — so dismissing has to hand
  // it back rather than dropping the user on <body>.
  it.each([
    ['Cancel', () => click(document.querySelector('.fm-dialog-cancel')!)],
    ['Escape', () => key(document, 'Escape')],
    ['an outside click', () => {
      // `attachBackdropClose` only closes on a press that STARTED on the
      // backdrop, so a bare click is not the gesture.
      const backdrop = document.querySelector('.fm-dialog-backdrop')!;
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      click(backdrop);
    }],
  ])('returns focus to the File trigger when dismissed by %s', async (_name, dismiss) => {
    const app = mountWith(wsWith());
    openFileMenu(app);
    click(row('New dashboard…'));
    await flush();
    dismiss();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(document.activeElement).toBe(app.dom.fileBtn);
    expect((await loadActiveWorkspace(app)).dashboards).toEqual([]);
  });

  it('focuses and selects the name field so typing replaces the default', async () => {
    const app = mountWith(wsWith());
    openFileMenu(app);
    click(row('New dashboard…'));
    await flush();
    expect(document.activeElement).toBe(document.querySelector('.fm-dialog-input'));
  });
});

describe('surface overlay disposal', () => {
  // #424: the Import workspace picker('Import workspace…') file input no longer opens a
  // "which dashboard?" dialog (every bundled Dashboard imports directly) —
  // drive the body-mounted dialog through Import Dashboard's own
  // multi-dashboard picker instead, alongside a still-open dropdown menu.
  it('closes both the dropdown and a body-mounted File dialog', () => {
    const app = mount({ FileReader: fakeReader(bundleText({
      dashboards: [dashboardDoc({ id: 'a' }), dashboardDoc({ id: 'b' })],
    })) });
    openFileMenu(app);
    pickDashboardImport(app);
    expect(document.querySelector('.fm-dialog-backdrop')).not.toBeNull();
    disposeFileMenuOverlays(app);
    expect(document.querySelector('.file-menu')).toBeNull();
    expect(document.querySelector('.fm-dialog-backdrop')).toBeNull();
  });

  // Issue test 13. The pickers are menu-PARENTED, so they go with the menu
  // whether or not the user ever picked a file — the case that used to leak,
  // when `triggerImportDashboard` body-mounted an input removed only on
  // `change` and the user cancelled the native chooser.
  it('repeated picker use and surface switching leave nothing mounted', () => {
    const app = mountOn(dashEdit('d1'));
    const mounted = () => ({
      inputs: document.querySelectorAll('input[type=file]').length,
      menus: document.querySelectorAll('.file-menu').length,
      overlays: document.querySelectorAll('.fm-overlay').length,
      dialogs: document.querySelectorAll('.fm-dialog-backdrop').length,
    });
    // Open each import row in turn and CANCEL the chooser every time (no
    // `change` ever fires), across both surface contexts.
    for (const context of [dashEdit('d1'), { surface: 'query' } as FileMenuSurfaceContext, dashEdit('d1')]) {
      for (const label of ['Import queries…', 'Import workspace…', 'Import dashboard…']) {
        openFileMenu(app, context);
        const target = row(label);
        if (target.getAttribute('aria-disabled') !== 'true') click(target);
        else disposeFileMenuOverlays(app); // disabled row: close the menu directly
      }
    }
    disposeFileMenuOverlays(app);
    expect(mounted()).toEqual({ inputs: 0, menus: 0, overlays: 0, dialogs: 0 });
  });
});

// Issue test 12: the SAME trigger contract on both surfaces, including the
// focus restoration neither surface asserted before.
describe('trigger contract (#452)', () => {
  it.each([
    ['Query', undefined],
    ['Dashboard Edit', dashEdit('d1')],
  ] as [string, FileMenuSurfaceContext | undefined][])(
    '%s: click toggles, Escape closes, and both restore focus to the trigger',
    async (_name, context) => {
      const app = context ? mountOn(context) : mount();
      const btn = app.dom.fileBtn!;
      // click opens
      click(btn);
      expect(document.querySelector('.file-menu')).not.toBeNull();
      expect(btn.getAttribute('aria-expanded')).toBe('true');
      // clicking the trigger again closes AND restores focus
      await flush();
      click(btn);
      expect(document.querySelector('.file-menu')).toBeNull();
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(btn);
      // Escape closes AND restores focus
      click(btn);
      await flush();
      key(document, 'Escape');
      expect(document.querySelector('.file-menu')).toBeNull();
      expect(document.activeElement).toBe(btn);
      // outside click closes
      click(btn);
      click(document.querySelector('.fm-overlay')!);
      expect(document.querySelector('.file-menu')).toBeNull();
      // and the trigger still reopens afterwards — the handle was released
      click(btn);
      expect(document.querySelector('.file-menu')).not.toBeNull();
    },
  );
});

describe('decode failures', () => {
  it('malformed JSON toasts the parse diagnostic (no legacy fallback)', () => {
    const app = mount({ FileReader: fakeReader('{not json') });
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    expect(toast()).toBe('✕ Not a valid JSON file');
  });

  it('a read error toasts', () => {
    const app = mount({ FileReader: fakeReader('', true) });
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    expect(toast()).toBe('✕ Could not read file');
  });

  it('falls back to the legacy Library decoder for a v1/v2 saved-queries file', async () => {
    const app = mount({ FileReader: fakeReader(legacyFile([{ id: 'x', name: 'New', sql: 'S' }])) });
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    await flush();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['New']);
    expect(toast()).toBe('Imported 1 query');
  });

  it('toasts the legacy diagnostic when neither decoder recognizes the file', () => {
    const app = mount({ FileReader: fakeReader(JSON.stringify({ foo: 1 })) });
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    expect(toast()).toMatch(/^✕ /);
  });

  it('a structurally-invalid portable bundle toasts its OWN diagnostic, never falling back to "Unrecognized file format"', () => {
    const bad = JSON.stringify({
      format: 'altinity-sql-browser/portable-bundle', version: 2, exportedAt: 'x',
      queries: [{ id: 'a' }], dashboards: [],
    });
    const app = mount({ FileReader: fakeReader(bad) });
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    expect(toast()).toMatch(/^✕ /);
    expect(toast()).not.toContain('Unrecognized file format');
  });
});

// #341/#344 review fix: `commitWorkspace`/`app.mutateWorkspace` must build the
// candidate from the LATEST committed aggregate at dequeue time, never from a
// snapshot taken before a producer entered the write queue. Both regression
// cases mirror saved-history.test.ts's own "concurrent saved-query writes"
// test — a first write is gated open manually so it stays pending in the
// queue while a SECOND op (here, a rename / an import) is fired behind it.
describe('mixed-producer serialization (#341/#344 review fix)', () => {
  it('a pending saved-query-style mutation commits before a queued rename builds its candidate — the rename lands on top, nothing reverts', async () => {
    const seed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'orig', name: 'Orig', queries: [panelQuery('q1', 'Q1')], dashboards: [],
    };
    const app = mount({ workspace: statefulWorkspaceRepo(seed) });
    app.state.savedQueries = seed.queries;
    app.state.workspaceId = seed.id;
    app.state.libraryName.value = seed.name;
    renderLibraryTitle(app);

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const pendingMutation = app.serializeWrite(async () => {
      await gate; // stays pending in the queue until released below
      return app.workspace.commit({ ...seed, queries: [...seed.queries, panelQuery('q2', 'Q2')] });
    });

    // Fire the rename UI flow (inline title edit, Enter commits) while the
    // mutation above is still queued ahead of it — `renameWorkspaceAction`
    // isn't exported, so drive it the same way `workspace title` above does.
    click(app.dom.libraryTitle!.querySelector('.lib-name')!);
    const input = app.dom.libraryTitle!.querySelector<HTMLInputElement>('.lib-name-input')!;
    input.value = 'Renamed';
    key(input, 'Enter');

    release();
    await pendingMutation;
    await app.flushWorkspaceWrites();

    const finalWs = await loadActiveWorkspace(app);
    // A `renameWorkspaceAction` that built its candidate from a pre-queue
    // snapshot would have re-committed the ORIGINAL [q1] catalog, silently
    // reverting the q2 mutation that landed while it waited.
    expect(finalWs.queries.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(finalWs.name).toBe('Renamed');
  });

  it('a pending saved-query-style mutation commits before a queued Import queries builds its candidate — the import lands on top of the post-mutation catalog', async () => {
    const seed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'lib', name: 'Lib', queries: [panelQuery('q1', 'Q1')], dashboards: [],
    };
    const app = mount({
      workspace: statefulWorkspaceRepo(seed),
      FileReader: fakeReader(bundleText({ queries: [panelQuery('new1', 'New1')] })),
    });
    app.state.savedQueries = seed.queries;
    app.state.workspaceId = seed.id;
    app.state.libraryName.value = seed.name;

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const pendingMutation = app.serializeWrite(async () => {
      await gate;
      return app.workspace.commit({ ...seed, queries: [...seed.queries, panelQuery('q2', 'Q2')] });
    });

    // No incoming/existing id overlap (`new1` vs `q1`/eventual `q2`) → the
    // import commits directly, no conflict dialog — queued behind the pending
    // mutation above the moment the file is picked.
    openFileMenu(app);
    pickFile(picker('Import queries…'));

    release();
    await pendingMutation;
    await app.flushWorkspaceWrites();

    const finalWs = await loadActiveWorkspace(app);
    // A stale-snapshot import would have planned against [q1] only, dropping
    // q2 from the committed candidate.
    expect(finalWs.queries.map((q) => q.id).sort()).toEqual(['new1', 'q1', 'q2']);
  });

  // #344 review 3: the conflict DECISIONS are collected against the pre-queue
  // snapshot; a mutation landing in the queue in between can mint a conflict
  // the user never saw. The planner defaults an undecided conflict to 'skip' —
  // without dequeue-time revalidation the import would silently drop the
  // incoming query and still toast success.
  it('a conflict minted while the import waits in the queue ABORTS the import (content differs) instead of silently skipping', async () => {
    const seed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'lib', name: 'Lib', queries: [panelQuery('q1', 'Q1')], dashboards: [],
    };
    const app = mount({
      workspace: statefulWorkspaceRepo(seed),
      FileReader: fakeReader(bundleText({ queries: [panelQuery('new1', 'Theirs')] })),
    });
    app.state.savedQueries = seed.queries;
    app.state.workspaceId = seed.id;
    app.state.libraryName.value = seed.name;

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const pendingMutation = app.serializeWrite(async () => {
      await gate;
      // Mints the SAME id as the bundle's incoming query, with DIFFERENT content.
      return app.workspace.commit({ ...seed, queries: [...seed.queries, panelQuery('new1', 'Mine')] });
    });

    // Dialog time: existing=[q1], incoming=[new1] → no conflict, decisions=[].
    openFileMenu(app);
    pickFile(picker('Import queries…'));
    expect(document.querySelector('.fm-dialog-card')).toBeNull();

    release();
    await pendingMutation;
    await app.flushWorkspaceWrites();

    const finalWs = await loadActiveWorkspace(app);
    // The import aborted whole: the queued mutation's new1 ('Mine') stands,
    // the bundle's new1 ('Theirs') was neither imported nor silently skipped
    // under a success toast.
    expect(finalWs.queries.map((q) => queryName(q)).sort()).toEqual(['Mine', 'Q1']);
    expect(toast()).toBe('✕ Workspace changed while importing — nothing imported, try again');
  });

  it('a conflict minted while the import waits in the queue auto-resolves when canonically IDENTICAL — no duplicate, honest count', async () => {
    const seed: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'lib', name: 'Lib', queries: [panelQuery('q1', 'Q1')], dashboards: [],
    };
    const app = mount({
      workspace: statefulWorkspaceRepo(seed),
      FileReader: fakeReader(bundleText({ queries: [panelQuery('new1', 'New1')] })),
    });
    app.state.savedQueries = seed.queries;
    app.state.workspaceId = seed.id;
    app.state.libraryName.value = seed.name;

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const pendingMutation = app.serializeWrite(async () => {
      await gate;
      // Mints the same id with IDENTICAL content (the rapid double-import case).
      return app.workspace.commit({ ...seed, queries: [...seed.queries, panelQuery('new1', 'New1')] });
    });

    openFileMenu(app);
    pickFile(picker('Import queries…'));

    release();
    await pendingMutation;
    await app.flushWorkspaceWrites();

    const finalWs = await loadActiveWorkspace(app);
    // Auto-resolved to 'use-existing': exactly ONE new1, and the toast counts
    // it as imported (the query IS available after the import).
    expect(finalWs.queries.map((q) => q.id).sort()).toEqual(['new1', 'q1']);
    expect(toast()).toBe('Imported 1 query');
  });
});

describe('commit failure', () => {
  it('a rejected rename commit toasts the diagnostic and keeps the active name', async () => {
    const commit = vi.fn(async () => ({
      ok: false as const,
      diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'rename failed' }],
    }));
    const app = mount({ workspace: { commit } });
    app.state.libraryName.value = 'Original';
    renderLibraryTitle(app);
    click(app.dom.libraryTitle!.querySelector('.lib-name')!);
    const input = app.dom.libraryTitle!.querySelector<HTMLInputElement>('.lib-name-input')!;
    input.value = 'Renamed';
    key(input, 'Enter');
    await app.flushWorkspaceWrites();
    await flush();
    expect(toast()).toBe('✕ rename failed');
    expect(app.state.libraryName.value).toBe('Original');
  });

  it('a rejected create toasts the first diagnostic and leaves state untouched', async () => {
    const create = vi.fn(async () => ({
      ok: false as const, diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'nope' }],
    }));
    const app = mount({ workspace: { create } });
    app.state.savedQueries = [panelQuery('q1')];
    openFileMenu(app);
    click(item(/New workspace/)!);
    await flush();
    expect(toast()).toBe('✕ nope');
    expect(app.state.savedQueries.map((q) => q.id)).toEqual(['q1']);
  });

  it('a rejected imported-workspace create reports its diagnostic', async () => {
    const create = vi.fn(async () => ({
      ok: false as const,
      diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'import blocked' }],
    }));
    const app = mount({
      workspace: { create },
      FileReader: fakeReader(bundleText({ queries: [panelQuery('q1')] })),
    });
    openFileMenu(app);
    pickFile(picker('Import workspace…'));
    await app.flushWorkspaceWrites();
    await flush();
    expect(toast()).toBe('✕ import blocked');
  });

  it('an invalid imported workspace reports the planner diagnostic without creating', async () => {
    const create = vi.fn();
    const app = mount({
      workspace: { create },
      genId: () => '',
      FileReader: fakeReader(bundleText({ queries: [panelQuery('q1')] })),
    });
    openFileMenu(app);
    pickFile(picker('Import workspace…'));
    await app.flushWorkspaceWrites();
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect(toast()).toMatch(/^✕ /);
  });
});
