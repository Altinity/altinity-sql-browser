import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  libraryControls, renderLibraryTitle, openFileMenu,
  triggerImportDashboard, exportDashboardAction, renderDashboardNav,
} from '../../src/ui/file-menu.js';
import { queryName } from '../../src/core/saved-query.js';
import { decodePortableBundleJson } from '../../src/dashboard/model/portable-bundle-codec.js';
import { makeApp, statefulWorkspaceRepo } from '../helpers/fake-app.js';
import type { MakeAppOverrides } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';
import type { App } from '../../src/ui/app.types.js';
import type { DashboardDocumentV1, PortableBundleV1, SavedQueryV2, StoredWorkspaceV2 } from '../../src/generated/json-schema.types.js';

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
const loadActiveWorkspace = async (app: App): Promise<StoredWorkspaceV2> => {
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
const dashboardDoc = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  filters: [], tiles: [], ...over,
});
const bundleDoc = (over: Partial<PortableBundleV1> = {}): PortableBundleV1 => ({
  format: 'altinity-sql-browser/portable-bundle', version: 1,
  exportedAt: '2026-07-17T00:00:00.000Z', queries: [], dashboards: [], ...over,
});
const bundleText = (over: Partial<PortableBundleV1> = {}): string => JSON.stringify(bundleDoc(over));
const legacyFile = (queries: unknown[]): string =>
  JSON.stringify({ format: 'altinity-sql-browser/saved-queries', version: 1, queries });

// Build an app with the header controls mounted (File button + title slot in the DOM).
function mount<O extends MakeAppOverrides = Record<string, never>>(over: O = {} as O) {
  const app = makeApp(over);
  for (const node of libraryControls(app)) document.body.appendChild(node);
  return app;
}
// #302: the File menu now only appends `importQueriesInput, openWorkspaceInput`
// (in that order) — the old `importDashboardInput` between them is gone. #342
// renamed the picker/action to "Open workspace…" without changing append order.
const picker = (i: number): HTMLInputElement => document.querySelectorAll<HTMLInputElement>('.file-menu input[type=file]')[i];
const pickFile = (input: HTMLInputElement, name = 'file.json'): void => {
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name }] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
};
// #302: Import Dashboard is reachable only via `triggerImportDashboard`, which
// builds its own hidden file input and appends it to `document.body` (no menu
// involved) — pick the last file input appended to body after triggering.
const pickDashboardImport = (app: App, name = 'file.json'): void => {
  triggerImportDashboard(app);
  const input = [...document.querySelectorAll<HTMLInputElement>('input[type=file]')].pop()!;
  pickFile(input, name);
};

afterEach(() => document.body.replaceChildren());

describe('header Dashboard nav (#302)', () => {
  it('the File header button opens the menu through its click handler', () => {
    const app = mount();
    click(app.dom.fileBtn!);
    expect(document.querySelector('.file-menu')).not.toBeNull();
  });

  it('libraryControls builds a "Dashboard →" nav (hidden when there is no Dashboard) that opens the Dashboard on click', () => {
    const app = mount();
    const nav = app.dom.dashboardNav!;
    expect(nav).toBeTruthy();
    expect(nav.classList.contains('hd-dash-nav')).toBe(true);
    expect(nav.getAttribute('aria-label')).toBe('Open Dashboard');
    expect(nav.querySelector('.hd-dash-nav-label')!.textContent).toBe('Dashboard →');
    expect(nav.hidden).toBe(true); // no Dashboard by default
    app.actions.openDashboard = vi.fn();
    click(nav);
    expect(app.actions.openDashboard).toHaveBeenCalled();
  });

  it('renderDashboardNav toggles .hidden with app.state.dashboard', () => {
    const app = mount();
    app.state.dashboard = null;
    renderDashboardNav(app);
    expect(app.dom.dashboardNav!.hidden).toBe(true);
    app.state.dashboard = dashboardDoc();
    renderDashboardNav(app);
    expect(app.dom.dashboardNav!.hidden).toBe(false);
  });

  it('renderDashboardNav no-ops before libraryControls has built the slot', () => {
    const app = makeApp();
    expect(app.dom.dashboardNav).toBeUndefined();
    expect(() => renderDashboardNav(app)).not.toThrow();
  });
});

describe('variable history (#171)', () => {
  it('the toggle reflects the current preference and flips it on change', () => {
    const app = mount();
    app.state.varRecentDisabled = false;
    openFileMenu(app);
    const checkbox = document.querySelector<HTMLInputElement>('.fm-checkbox')!;
    expect(checkbox.checked).toBe(true); // recording ON ⇒ box checked
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.state.varRecentDisabled).toBe(true);
    expect(app.params.saveVarRecentDisabled).toHaveBeenCalled();
  });
  it('starts unchecked when the preference is already disabled', () => {
    const app = mount();
    app.state.varRecentDisabled = true;
    openFileMenu(app);
    expect(document.querySelector<HTMLInputElement>('.fm-checkbox')!.checked).toBe(false);
  });
  it('"Clear all recent values" calls app.params.clearAllVarRecent and toasts', () => {
    const app = mount();
    openFileMenu(app);
    click(item(/Clear all recent values/)!);
    expect(app.params.clearAllVarRecent).toHaveBeenCalled();
    expect(toast()).toContain('Cleared recent variable values');
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

describe('file menu structure', () => {
  it('lists every section + item, reflects the (pluralized) count, and re-open is a no-op', () => {
    const app = mount();
    app.state.savedQueries = [panelQuery('s1', 'A'), panelQuery('s2', 'B')];
    openFileMenu(app);
    expect([...document.querySelectorAll('.fm-label')].map((l) => l.textContent)).toEqual([
      'New workspace…', 'Import workspace…', 'Export workspace…', 'Import queries…',
      'Download Markdown', 'Download SQL',
      'Remember recent variable values', 'Clear all recent values',
    ]);
    expect([...document.querySelectorAll('.fm-section')].map((s) => s.textContent)).toEqual(
      ['Share / Publish', 'Variable history']);
    expect(document.querySelector('.fm-count')!.textContent).toBe('2 queries in workspace');
    openFileMenu(app);
    expect(document.querySelectorAll('.file-menu')).toHaveLength(1);
    // …and the aria-expanded re-entrancy guard means the redundant open added
    // no orphan hidden pickers either (exactly the two from the first open).
    expect(document.querySelectorAll('.file-menu input[type=file]')).toHaveLength(2);
  });

  it('autofocuses the first item (New workspace…) on open', async () => {
    const app = mount();
    openFileMenu(app);
    await flush();
    expect(document.activeElement).toBe(item(/New workspace/));
  });

  it('#342: the first four rows are an unlabeled primary group (no heading before or inside it), followed by a separator', async () => {
    const app = mount();
    openFileMenu(app);
    const menu = document.querySelector('.file-menu')!;
    const rows = [...menu.children];
    const primary = rows.slice(0, 4);
    expect(primary.every((r) => r.classList.contains('fm-item'))).toBe(true);
    expect(primary.map((r) => r.querySelector('.fm-label')!.textContent)).toEqual([
      'New workspace…', 'Import workspace…', 'Export workspace…', 'Import queries…',
    ]);
    expect(rows[4].classList.contains('fm-sep')).toBe(true);
    // Keyboard focus order matches the visual row order exactly.
    await flush();
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(item(/Import workspace/));
  });

  it('footer shows the empty state when there are no queries', () => {
    const app = mount();
    openFileMenu(app);
    expect(document.querySelector('.fm-count')!.textContent).toBe('Workspace is empty');
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

describe('Export', () => {
  // #302: Export Dashboard is invoked from the Dashboard page's own File menu
  // (`app.actions.exportDashboard` → `exportDashboardAction`), not the
  // Workbench menu — drive it directly.
  it('exportDashboardAction toasts "No dashboard to export" and does not download when there is no Dashboard', async () => {
    const app = mount();
    await exportDashboardAction(app);
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toBe('No dashboard to export');
  });

  it('exportDashboardAction downloads a valid bundle containing only its query dependencies', async () => {
    const app = mount();
    app.state.dashboard = dashboardDoc({ title: 'Ops', tiles: [{ id: 't1', queryId: 'p1' }] });
    app.state.savedQueries = [panelQuery('p1', 'Panel'), panelQuery('unrelated', 'Unrelated')];
    await exportDashboardAction(app);
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
    const filterQuery: SavedQueryV2 = {
      id: 'f1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'F', dashboard: { role: 'filter' } },
    };
    const app = mount();
    // A tile referencing a filter-role query — legal to ASSEMBLE (Wave 1's
    // pure builder never re-validates), but `encodePortableBundleJson`'s own
    // re-validation catches the role mismatch.
    app.state.dashboard = dashboardDoc({ tiles: [{ id: 't1', queryId: 'f1' }] });
    app.state.savedQueries = [filterQuery];
    await exportDashboardAction(app);
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toMatch(/^✕ /);
  });

  // #341: the export must build from the latest COMMITTED workspace
  // (`loadCurrent`), not stale `app.state` — the whole reason the actions
  // became async (flush pending writes → read back the aggregate).
  it('exportWorkspaceAction builds the bundle from the committed workspace (loadCurrent), not stale app.state (#341)', async () => {
    const committed: StoredWorkspaceV2 = {
      storageVersion: 2, id: 'w1', key: 'committed_lib', name: 'Committed Lib',
      queries: [panelQuery('c1', 'Committed')], dashboard: null,
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
    const committed: StoredWorkspaceV2 = {
      storageVersion: 2, id: 'w1', key: 'lib', name: 'Lib',
      queries: [panelQuery('c1', 'Committed')],
      dashboard: dashboardDoc({ title: 'Committed', tiles: [{ id: 't1', queryId: 'c1' }] }),
    };
    const app = mount({ workspace: { loadById: async () => ({ status: 'ok' as const, workspace: committed }) } });
    app.state.dashboard = dashboardDoc({ title: 'Stale', tiles: [{ id: 't9', queryId: 'stale' }] });
    app.state.savedQueries = [panelQuery('stale', 'Stale')];
    await exportDashboardAction(app);
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

  it('Download Markdown + SQL: empty → toast; non-empty → files named from the workspace', () => {
    const app = mount();
    openFileMenu(app);
    click(item(/Download Markdown/)!);
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toBe('Nothing to save');
    setSaved(app, [{ id: 's1', name: 'A', sql: 'SELECT 1', favorite: false, description: 'd' }]);
    app.state.libraryName.value = 'Lib';
    openFileMenu(app);
    click(item(/Download Markdown/)!);
    expect(app.downloadFile.mock.calls.at(-1)!.slice(0, 2)).toEqual(['Lib.md', 'text/markdown']);
    openFileMenu(app);
    click(item(/Download SQL/)!);
    expect(app.downloadFile.mock.calls.at(-1)!.slice(0, 2)).toEqual(['Lib.sql', 'application/sql']);
    // an unnamed / whitespace-only workspace name falls back to "queries"
    app.state.libraryName.value = '';
    openFileMenu(app);
    click(item(/Download Markdown/)!);
    expect(app.downloadFile.mock.calls.at(-1)![0]).toBe('queries.md');
    app.state.libraryName.value = '   ';
    openFileMenu(app);
    click(item(/Download SQL/)!);
    expect(app.downloadFile.mock.calls.at(-1)![0]).toBe('queries.sql');
  });
});

describe('Import queries', () => {
  it('the menu item closes the menu, opens the picker, and a picked file imports without a conflict dialog', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'Q1'), panelQuery('q2', 'Q2')] })) });
    app.state.savedQueries = [panelQuery('q1', 'Q1')]; // canonically identical to the incoming q1 → auto-resolved
    openFileMenu(app);
    const input = picker(0);
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
    pickFile(picker(0));
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.savedQueries.map((q) => q.id).sort()).toEqual(['existing', 'new1', 'new2']);
  });

  it('picking no file is a no-op', () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1')] })) });
    openFileMenu(app);
    const input = picker(0);
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.state.savedQueries).toEqual([]);
  });

  it('opens a conflict dialog for genuinely differing ids; the global default resolves an unmarked row', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'NewName')] })) });
    app.state.savedQueries = [panelQuery('q1', 'OldName')];
    openFileMenu(app);
    pickFile(picker(0));
    const dialog = document.querySelector('.fm-dialog-card')!;
    expect(dialog.textContent).toContain('Resolve 1 conflicting query');
    expect(dialog.textContent).toContain('OldName'); // row shows the EXISTING query's name
    click(document.querySelector('.fm-dialog-confirm')!); // Apply with the default (use-existing)
    await flush();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['OldName']);
    expect(toast()).toBe('Imported 1 query');
  });

  it('a per-row override wins over the global default', async () => {
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [panelQuery('q1', 'NewName')] })) });
    app.state.savedQueries = [panelQuery('q1', 'OldName')];
    openFileMenu(app);
    pickFile(picker(0));
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
    pickFile(picker(0));
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
    pickFile(picker(0));
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
    pickFile(picker(0));
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
    pickFile(picker(0));
    click(document.querySelector('.fm-dialog-cancel')!);
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['OldName']);
  });
});

describe('Import Dashboard', () => {
  // #302: reachable only through `triggerImportDashboard` now (the Dashboard
  // page's own File menu → `app.actions.importDashboard`) — no Workbench menu
  // item, no `picker(...)` index into `.file-menu`.
  it('triggerImportDashboard appends a hidden file input to the body and clicks it; a single-dashboard file imports directly, minting a fresh id/revision, and the input self-removes on change', async () => {
    const dep = panelQuery('p1', 'Panel');
    const dash = dashboardDoc({ id: 'src-d', title: 'Sales', tiles: [{ id: 't1', queryId: 'p1' }] });
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [dep], dashboards: [dash] })) });
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    triggerImportDashboard(app);
    const input = [...document.querySelectorAll<HTMLInputElement>('input[type=file]')].pop()!;
    expect(input.parentElement).toBe(document.body);
    expect(input.style.display).toBe('none');
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
    pickFile(input);
    await flush();
    expect(input.isConnected).toBe(false); // self-removed once the change fired
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.dashboard).not.toBeNull();
    expect(app.state.dashboard!.id).not.toBe('src-d'); // mode 'copy' mints a fresh id
    expect(app.state.dashboard!.revision).toBe(1);
    expect(app.state.dashboard!.title).toBe('Sales');
    expect(app.state.savedQueries.map((q) => q.id)).toContain('p1');
    expect(toast()).toBe('Imported dashboard');
  });

  it('confirms before discarding an existing Dashboard, then replaces it on confirm', async () => {
    const dep = panelQuery('p1', 'Panel');
    const dash = dashboardDoc({ id: 'src-d', title: 'Sales', tiles: [{ id: 't1', queryId: 'p1' }] });
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [dep], dashboards: [dash] })) });
    app.state.dashboard = dashboardDoc({ id: 'old', title: 'My existing dashboard' });
    pickDashboardImport(app);
    const dialog = document.querySelector('.fm-dialog-card')!;
    expect(dialog.textContent).toContain('Import and replace current Dashboard?');
    click(document.querySelector('.fm-dialog-confirm')!);
    await flush();
    expect(app.state.dashboard!.title).toBe('Sales');
    expect(app.state.dashboard!.id).not.toBe('old'); // mode 'copy' mints a fresh id
    expect(toast()).toBe('Imported dashboard');
  });

  it('cancelling the discard-Dashboard confirm keeps the current Dashboard and imports nothing', () => {
    const dash = dashboardDoc({ id: 'src-d', title: 'Sales' });
    const app = mount({ FileReader: fakeReader(bundleText({ dashboards: [dash] })) });
    app.state.dashboard = dashboardDoc({ id: 'old', title: 'My existing dashboard' });
    pickDashboardImport(app);
    expect(document.querySelector('.fm-dialog-card')!.textContent).toContain('Import and replace current Dashboard?');
    click(document.querySelector('.fm-dialog-cancel')!);
    expect(app.state.dashboard!.id).toBe('old');
    expect(app.state.dashboard!.title).toBe('My existing dashboard');
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

  it('cancelling the multi-dashboard picker imports nothing', () => {
    const dashA = dashboardDoc({ id: 'a', title: 'Alpha' });
    const dashB = dashboardDoc({ id: 'b', title: 'Beta' });
    const app = mount({ FileReader: fakeReader(bundleText({ dashboards: [dashA, dashB] })) });
    pickDashboardImport(app);
    click(document.querySelector('.fm-dialog-cancel')!);
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

describe('afterLibraryChange — dashboard route (#302)', () => {
  it('on the dashboard route, a commit reloads the dashboard route and skips the Workbench repaint', async () => {
    const dep = panelQuery('p1', 'Panel');
    const dash = dashboardDoc({ id: 'src-d', title: 'Sales', tiles: [{ id: 't1', queryId: 'p1' }] });
    const app = mount({ FileReader: fakeReader(bundleText({ queries: [dep], dashboards: [dash] })) });
    app.dashboardRoute = true;
    app.reloadDashboardRoute = vi.fn();
    // The nav was built (hidden — no Dashboard yet) by `mount()`'s own
    // `libraryControls` call; the dashboard-route branch must never re-run
    // `renderDashboardNav`, even though the commit below gives the workspace
    // a Dashboard.
    expect(app.dom.dashboardNav!.hidden).toBe(true);
    pickDashboardImport(app);
    await flush();
    expect(app.reloadDashboardRoute).toHaveBeenCalled();
    expect(app.state.dashboard).not.toBeNull(); // the commit itself still landed
    expect(app.updateSaveBtn).not.toHaveBeenCalled();
    expect(app.updateEditorModeUi).not.toHaveBeenCalled();
    expect(app.dom.dashboardNav!.hidden).toBe(true); // renderDashboardNav was skipped
  });
});

describe('Import workspace (#406 additive collection)', () => {
  it('the menu item closes the menu, opens the picker, and creates a fresh active workspace', async () => {
    const dep = panelQuery('p1', 'Panel');
    const dash = dashboardDoc({ id: 'd1', title: 'Ops', tiles: [{ id: 't1', queryId: 'p1' }] });
    const create = vi.fn(async (workspace: StoredWorkspaceV2) => ({
      ok: true as const, workspace, dashboardRevision: workspace.dashboard?.revision ?? null,
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
    app.state.savedQueries = [panelQuery('old', 'Old')];
    const oldId = app.state.workspaceId;
    openFileMenu(app);
    const input = picker(1);
    input.click = vi.fn();
    click(item(/Import workspace/)!);
    expect(document.querySelector('.file-menu')).toBeNull();
    expect(input.click).toHaveBeenCalled();
    pickFile(input);
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      storageVersion: 2, key: 'imported_ops_3', name: 'Imported Ops',
    });
    expect(create.mock.calls[0][0].id).not.toBe(oldId);
    expect(app.state.savedQueries.map((q) => q.id)).toEqual(['p1']);
    expect(app.state.dashboard!.id).toBe('d1');
    expect(toast()).toBe('Imported workspace');
  });

  it('shows a picker with a "No dashboard" option for a multi-dashboard bundle', async () => {
    const dashA = dashboardDoc({ id: 'a', title: 'Alpha' });
    const dashB = dashboardDoc({ id: 'b', title: 'Beta' });
    const app = mount({ FileReader: fakeReader(bundleText({ dashboards: [dashA, dashB] })) });
    app.state.dashboard = dashboardDoc({ id: 'existing', title: 'Existing' });
    openFileMenu(app);
    pickFile(picker(1));
    const dialog = document.querySelector('.fm-dialog-card')!;
    expect(dialog.textContent).toContain('Import workspace — which dashboard?');
    const noneRow = [...dialog.querySelectorAll<HTMLButtonElement>('.fm-item')].find((b) => (b.textContent || '').includes('No dashboard'))!;
    click(noneRow);
    await flush();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.dashboard).toBeNull();
  });

  it('dismisses the multi-dashboard picker on Escape', () => {
    const app = mount({
      FileReader: fakeReader(bundleText({
        dashboards: [
          dashboardDoc({ id: 'a', title: 'Alpha' }),
          dashboardDoc({ id: 'b', title: 'Beta' }),
        ],
      })),
    });
    openFileMenu(app);
    pickFile(picker(1));
    const event = new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
  });

  it('auto-picks the sole Dashboard in a single-dashboard bundle (no picker)', async () => {
    const dash = dashboardDoc({ id: 'only', title: 'Only' });
    const app = mount({ FileReader: fakeReader(bundleText({ dashboards: [dash] })) });
    openFileMenu(app);
    pickFile(picker(1));
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
    pickFile(picker(1));
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
    pickFile(picker(1));
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
    const oldId = app.state.workspaceId;
    openFileMenu(app);
    click(item(/New workspace/)!);
    await flush();
    expect(document.querySelector('.fm-dialog-backdrop')).toBeNull();
    expect(app.state.savedQueries).toEqual([]);
    expect(app.state.libraryName.value).toBe('SQL Library');
    expect(app.state.workspaceKey).toBe('sql_library_3');
    expect(app.state.workspaceId).not.toBe(oldId);
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

describe('decode failures', () => {
  it('malformed JSON toasts the parse diagnostic (no legacy fallback)', () => {
    const app = mount({ FileReader: fakeReader('{not json') });
    openFileMenu(app);
    pickFile(picker(0));
    expect(toast()).toBe('✕ Not a valid JSON file');
  });

  it('a read error toasts', () => {
    const app = mount({ FileReader: fakeReader('', true) });
    openFileMenu(app);
    pickFile(picker(0));
    expect(toast()).toBe('✕ Could not read file');
  });

  it('falls back to the legacy Library decoder for a v1/v2 saved-queries file', async () => {
    const app = mount({ FileReader: fakeReader(legacyFile([{ id: 'x', name: 'New', sql: 'S' }])) });
    openFileMenu(app);
    pickFile(picker(0));
    await flush();
    expect(app.state.savedQueries.map((q) => queryName(q))).toEqual(['New']);
    expect(toast()).toBe('Imported 1 query');
  });

  it('toasts the legacy diagnostic when neither decoder recognizes the file', () => {
    const app = mount({ FileReader: fakeReader(JSON.stringify({ foo: 1 })) });
    openFileMenu(app);
    pickFile(picker(0));
    expect(toast()).toMatch(/^✕ /);
  });

  it('a structurally-invalid portable bundle toasts its OWN diagnostic, never falling back to "Unrecognized file format"', () => {
    const bad = JSON.stringify({
      format: 'altinity-sql-browser/portable-bundle', version: 1, exportedAt: 'x',
      queries: [{ id: 'a' }], dashboards: [],
    });
    const app = mount({ FileReader: fakeReader(bad) });
    openFileMenu(app);
    pickFile(picker(0));
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
    const seed: StoredWorkspaceV2 = {
      storageVersion: 2, id: 'w1', key: 'orig', name: 'Orig', queries: [panelQuery('q1', 'Q1')], dashboard: null,
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
    const seed: StoredWorkspaceV2 = {
      storageVersion: 2, id: 'w1', key: 'lib', name: 'Lib', queries: [panelQuery('q1', 'Q1')], dashboard: null,
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
    pickFile(picker(0));

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
    const seed: StoredWorkspaceV2 = {
      storageVersion: 2, id: 'w1', key: 'lib', name: 'Lib', queries: [panelQuery('q1', 'Q1')], dashboard: null,
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
    pickFile(picker(0));
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
    const seed: StoredWorkspaceV2 = {
      storageVersion: 2, id: 'w1', key: 'lib', name: 'Lib', queries: [panelQuery('q1', 'Q1')], dashboard: null,
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
    pickFile(picker(0));

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
    pickFile(picker(1));
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
    pickFile(picker(1));
    await app.flushWorkspaceWrites();
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect(toast()).toMatch(/^✕ /);
  });
});
