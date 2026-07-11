import { describe, it, expect, vi, afterEach } from 'vitest';
import { libraryControls, renderLibraryTitle, openFileMenu } from '../../src/ui/file-menu.js';
import { makeApp } from '../helpers/fake-app.js';

const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));
const key = (el, k, mods = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }));
const item = (re) => [...document.querySelectorAll('.fm-item')].find((b) => re.test(b.textContent));
const toast = () => document.querySelector('.share-toast').textContent;

// A FileReader stub: readAsText resolves synchronously with `content` (or errors).
const fakeReader = (content, fail) => class {
  readAsText() { this.result = content; if (fail) this.onerror && this.onerror(); else this.onload && this.onload(); }
};
const envFile = (queries) => JSON.stringify({ format: 'altinity-sql-browser/saved-queries', version: 1, queries });

// Build an app with the header controls mounted (File button + title slot in the DOM).
function mount(over = {}) {
  const app = makeApp(over);
  for (const node of libraryControls(app)) document.body.appendChild(node);
  return app;
}
const picker = (i) => document.querySelectorAll('.file-menu input[type=file]')[i];

afterEach(() => document.body.replaceChildren());

describe('open as dashboard', () => {
  it('opens the dashboard when at least one query is favorited', () => {
    const app = mount();
    app.actions.openDashboard = vi.fn();
    app.state.savedQueries = [{ id: '1', name: 'Q', sql: 'SELECT 1', favorite: true }];
    openFileMenu(app);
    const btn = item(/Open as dashboard/);
    expect(btn).toBeTruthy();
    click(btn);
    expect(app.actions.openDashboard).toHaveBeenCalled();
  });

  it('is disabled (with a reason) and toasts when there are no favorites', () => {
    const app = mount();
    app.actions.openDashboard = vi.fn();
    app.state.savedQueries = [{ id: '1', name: 'Q', sql: 'SELECT 1', favorite: false }];
    openFileMenu(app);
    const btn = item(/Open as dashboard/);
    expect(btn.textContent).toContain('no favorites');
    click(btn);
    expect(app.actions.openDashboard).not.toHaveBeenCalled();
    expect(toast()).toContain('Star a query');
  });
});

describe('variable history (#171)', () => {
  it('the toggle reflects the current preference and flips it on change', () => {
    const app = mount();
    app.state.varRecentDisabled = false;
    openFileMenu(app);
    const checkbox = document.querySelector('.fm-checkbox');
    expect(checkbox.checked).toBe(true); // recording ON ⇒ box checked
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.state.varRecentDisabled).toBe(true);
    expect(app.saveVarRecentDisabled).toHaveBeenCalled();
  });
  it('starts unchecked when the preference is already disabled', () => {
    const app = mount();
    app.state.varRecentDisabled = true;
    openFileMenu(app);
    expect(document.querySelector('.fm-checkbox').checked).toBe(false);
  });
  it('"Clear all recent values" calls app.clearAllVarRecent and toasts', () => {
    const app = mount();
    openFileMenu(app);
    click(item(/Clear all recent values/));
    expect(app.clearAllVarRecent).toHaveBeenCalled();
    expect(toast()).toContain('Cleared recent variable values');
  });
});

describe('library title', () => {
  it('renders the name + dirty dot; inline rename commits on Enter and persists', () => {
    const app = mount();
    app.state.libraryName.value = 'My queries';
    app.state.libraryDirty.value = true;
    renderLibraryTitle(app);
    expect(app.dom.libraryTitle.querySelector('.lib-name-text').textContent).toBe('My queries');
    expect(app.dom.libraryTitle.querySelector('.lib-dirty')).not.toBeNull();
    click(app.dom.libraryTitle.querySelector('.lib-name'));
    expect(app.editingLibrary).toBe(true);
    const input = app.dom.libraryTitle.querySelector('.lib-name-input');
    expect(input.value).toBe('My queries');
    input.value = 'Renamed';
    key(input, 'Enter');
    expect(app.state.libraryName.value).toBe('Renamed');
    expect(app.editingLibrary).toBe(false);
    expect(app.saveStr).toHaveBeenCalled();
    app.state.libraryDirty.value = false;
    renderLibraryTitle(app);
    expect(app.dom.libraryTitle.querySelector('.lib-dirty')).toBeNull();
  });

  it('inline rename: Escape cancels, blur commits, empty commit is a no-op, double-fire guarded', () => {
    const app = mount();
    app.state.libraryName.value = 'Orig';
    renderLibraryTitle(app);
    // Escape cancels
    click(app.dom.libraryTitle.querySelector('.lib-name'));
    let input = app.dom.libraryTitle.querySelector('.lib-name-input');
    input.value = 'X';
    key(input, 'Escape');
    expect(app.state.libraryName.value).toBe('Orig');
    // empty name commit → no rename
    click(app.dom.libraryTitle.querySelector('.lib-name'));
    input = app.dom.libraryTitle.querySelector('.lib-name-input');
    input.value = '   ';
    key(input, 'Enter');
    expect(app.state.libraryName.value).toBe('Orig');
    // blur commits, then a second event on the detached input is guarded
    click(app.dom.libraryTitle.querySelector('.lib-name'));
    input = app.dom.libraryTitle.querySelector('.lib-name-input');
    input.value = 'Blurred';
    input.dispatchEvent(new Event('blur'));
    expect(app.state.libraryName.value).toBe('Blurred');
    key(input, 'Enter');
    expect(app.state.libraryName.value).toBe('Blurred');
  });

  it('renderLibraryTitle no-ops without a slot', () => {
    expect(() => renderLibraryTitle(makeApp())).not.toThrow();
  });
});

describe('file menu', () => {
  it('lists every section + item, reflects the (pluralized) count, and re-open is a no-op', () => {
    const app = mount();
    app.state.savedQueries = [
      { id: 's1', name: 'A', sql: '1', favorite: false },
      { id: 's2', name: 'B', sql: '2', favorite: false },
    ];
    openFileMenu(app);
    expect([...document.querySelectorAll('.fm-label')].map((l) => l.textContent)).toEqual([
      'New Library', 'Open as dashboard', 'Remember recent variable values', 'Clear all recent values',
      'Save JSON', 'Open…', 'Append…', 'Download Markdown', 'Download SQL',
    ]);
    expect([...document.querySelectorAll('.fm-section')].map((s) => s.textContent)).toEqual(
      ['Dashboard', 'Variable history', 'Save library', 'Load from file', 'Share / publish']);
    expect(document.querySelector('.fm-count').textContent).toBe('2 queries in Library');
    openFileMenu(app);
    expect(document.querySelectorAll('.file-menu')).toHaveLength(1);
  });

  it('autofocuses the first item (New Library) on open', async () => {
    const app = mount();
    openFileMenu(app);
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(item(/New Library/));
  });

  it('footer shows the empty state when there are no queries', () => {
    const app = mount();
    openFileMenu(app);
    expect(document.querySelector('.fm-count').textContent).toBe('Library is empty');
  });

  it('closes on overlay click and on Escape (ignores other keys)', () => {
    const app = mount();
    openFileMenu(app);
    key(document, 'a'); // not Escape → stays open
    expect(document.querySelector('.file-menu')).not.toBeNull();
    click(document.querySelector('.fm-overlay'));
    expect(document.querySelector('.file-menu')).toBeNull();
    openFileMenu(app);
    key(document, 'Escape');
    expect(document.querySelector('.file-menu')).toBeNull();
  });
});

describe('Save JSON / Markdown / SQL downloads', () => {
  it('Save JSON: empty → toast; non-empty → download envelope, clear dirty', () => {
    const app = mount();
    openFileMenu(app);
    click(item(/Save JSON/));
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toBe('Nothing to save');
    app.state.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: true }];
    app.state.libraryName.value = 'My Lib';
    app.state.libraryDirty.value = true;
    openFileMenu(app);
    click(item(/Save JSON/));
    const [fname, mime, content] = app.downloadFile.mock.calls[0];
    expect(fname).toBe('My Lib.json');
    expect(mime).toBe('application/json');
    expect(JSON.parse(content).format).toBe('altinity-sql-browser/saved-queries');
    expect(app.state.libraryDirty.value).toBe(false);
    expect(toast()).toBe('Saved 1 query → .json');
  });

  it('Download Markdown + SQL: empty → toast; non-empty → files named from the library', () => {
    const app = mount();
    openFileMenu(app);
    click(item(/Download Markdown/));
    expect(app.downloadFile).not.toHaveBeenCalled();
    expect(toast()).toBe('Nothing to save');
    app.state.savedQueries = [{ id: 's1', name: 'A', sql: 'SELECT 1', favorite: false, description: 'd' }];
    app.state.libraryName.value = 'Lib';
    openFileMenu(app);
    click(item(/Download Markdown/));
    expect(app.downloadFile.mock.calls.at(-1).slice(0, 2)).toEqual(['Lib.md', 'text/markdown']);
    openFileMenu(app);
    click(item(/Download SQL/));
    expect(app.downloadFile.mock.calls.at(-1).slice(0, 2)).toEqual(['Lib.sql', 'application/sql']);
    // an unnamed / whitespace-only library name falls back to "queries"
    app.state.libraryName.value = '';
    openFileMenu(app);
    click(item(/Download Markdown/));
    expect(app.downloadFile.mock.calls.at(-1)[0]).toBe('queries.md');
    app.state.libraryName.value = '   ';
    openFileMenu(app);
    click(item(/Download SQL/));
    expect(app.downloadFile.mock.calls.at(-1)[0]).toBe('queries.sql');
  });
});

describe('Open / Append (JSON only)', () => {
  it('Open item closes the menu and opens the picker; a non-empty library confirms first', () => {
    const app = mount({ FileReader: fakeReader(envFile([{ id: 'x', name: 'New', sql: 'S' }, { name: 'New2', sql: 'S2' }])) });
    app.state.savedQueries = [
      { id: 's1', name: 'Old', sql: '1', favorite: false },
      { id: 's2', name: 'Old2', sql: '2', favorite: false },
    ];
    openFileMenu(app);
    const replaceInput = picker(0);
    replaceInput.click = vi.fn();
    click(item(/Open…/));
    expect(document.querySelector('.file-menu')).toBeNull(); // menu closed
    expect(replaceInput.click).toHaveBeenCalled();
    // user picks a file → confirm dialog (current library non-empty, plural copy)
    Object.defineProperty(replaceInput, 'files', { configurable: true, value: [{ name: 'team.json' }] });
    replaceInput.dispatchEvent(new Event('change', { bubbles: true }));
    const dialog = document.querySelector('.fm-dialog-card');
    expect(dialog.textContent).toContain('Open and replace current library?');
    expect(dialog.textContent).toContain('contains 2 queries');
    expect(dialog.textContent).toContain('current 2 saved queries');
    click(document.querySelector('.fm-dialog-confirm'));
    expect(app.state.savedQueries.map((q) => q.name)).toEqual(['New', 'New2']);
    expect(app.state.libraryName.value).toBe('team');
    expect(app.updateSaveBtn).toHaveBeenCalled();
    expect(toast()).toBe('Opened library · 2 queries');
  });

  it('Open into an empty library loads directly (no confirm); cancelling the picker is a no-op', () => {
    const app = mount({ FileReader: fakeReader(envFile([{ name: 'New', sql: 'S' }])) });
    openFileMenu(app);
    const input = picker(0);
    // cancel (no file chosen) → nothing happens
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.state.savedQueries).toEqual([]);
    // pick a file → loaded directly, name adopted, no dialog
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'lib.json' }] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.state.savedQueries.map((q) => q.name)).toEqual(['New']);
    expect(app.state.libraryName.value).toBe('lib');
  });

  it('Append item closes the menu, merges the file, and toasts counts', () => {
    const app = mount({ FileReader: fakeReader(envFile([{ id: 's1', name: 'A', sql: '1' }, { name: 'B', sql: '2' }])) });
    app.state.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    openFileMenu(app);
    const appendInput = picker(1);
    appendInput.click = vi.fn();
    click(item(/Append/));
    expect(document.querySelector('.file-menu')).toBeNull();
    expect(appendInput.click).toHaveBeenCalled();
    Object.defineProperty(appendInput, 'files', { configurable: true, value: [{ name: 'more.json' }] });
    appendInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.state.savedQueries.map((q) => q.name)).toEqual(['A', 'B']);
    expect(toast()).toBe('Added 1 · updated 0 · skipped 1'); // the duplicate A is skipped
  });

  it('Open / Append with no queries in the file → error toast', () => {
    const app = mount({ FileReader: fakeReader(envFile([])) });
    openFileMenu(app);
    Object.defineProperty(picker(0), 'files', { configurable: true, value: [{ name: 'empty.json' }] });
    picker(0).dispatchEvent(new Event('change', { bubbles: true }));
    expect(toast()).toBe('✕ No queries in file');
    openFileMenu(app);
    Object.defineProperty(picker(1), 'files', { configurable: true, value: [{ name: 'empty.json' }] });
    picker(1).dispatchEvent(new Event('change', { bubbles: true }));
    expect(toast()).toBe('✕ No queries in file');
  });

  it('invalid JSON → error toast; a read error → error toast', () => {
    const bad = mount({ FileReader: fakeReader('{not json') });
    openFileMenu(bad);
    Object.defineProperty(picker(0), 'files', { configurable: true, value: [{ name: 'bad.json' }] });
    picker(0).dispatchEvent(new Event('change', { bubbles: true }));
    expect(toast()).toBe('✕ Not a valid JSON file');
    document.body.replaceChildren();
    const err = mount({ FileReader: fakeReader('', true) });
    openFileMenu(err);
    Object.defineProperty(picker(0), 'files', { configurable: true, value: [{ name: 'x.json' }] });
    picker(0).dispatchEvent(new Event('change', { bubbles: true }));
    expect(toast()).toBe('✕ Could not read file');
  });
});

describe('New Library + confirm dialogs', () => {
  it('New Library: empty → clears directly; non-empty → confirm → New resets to the default', () => {
    const app = mount();
    openFileMenu(app);
    click(item(/New Library/));
    expect(document.querySelector('.fm-dialog-backdrop')).toBeNull();
    expect(toast()).toBe('Started a new library');
    app.state.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    app.state.libraryName.value = 'Old';
    openFileMenu(app);
    click(item(/New Library/));
    expect(document.querySelector('.fm-dialog-card').textContent).toContain('Start a new library?');
    click(document.querySelector('.fm-dialog-confirm'));
    expect(app.state.savedQueries).toEqual([]);
    expect(app.state.libraryName.value).toBe('SQL Library');
  });

  it('confirm dialog: Cancel, backdrop click, and Escape all dismiss; a card click does not', () => {
    const app = mount();
    app.state.savedQueries = [ // two queries → exercises the plural dialog copy
      { id: 's1', name: 'A', sql: '1', favorite: false },
      { id: 's2', name: 'B', sql: '2', favorite: false },
    ];
    const openNew = () => { openFileMenu(app); click(item(/New Library/)); };
    // Cancel
    openNew();
    click(document.querySelector('.fm-dialog-cancel'));
    expect(document.querySelector('.fm-dialog-backdrop')).toBeNull();
    expect(app.state.savedQueries).toHaveLength(2);
    // backdrop click
    openNew();
    const backdrop = document.querySelector('.fm-dialog-backdrop');
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    click(backdrop);
    expect(document.querySelector('.fm-dialog-backdrop')).toBeNull();
    // card click keeps it open; Escape closes it
    openNew();
    click(document.querySelector('.fm-dialog-card'));
    expect(document.querySelector('.fm-dialog-backdrop')).not.toBeNull();
    key(document, 'Escape');
    expect(document.querySelector('.fm-dialog-backdrop')).toBeNull();
    expect(app.state.savedQueries).toHaveLength(2);
  });

  it('a gesture starting on the card and ending on the backdrop does not dismiss it (#110)', () => {
    const app = mount();
    app.state.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    openFileMenu(app);
    click(item(/New Library/));
    const backdrop = document.querySelector('.fm-dialog-backdrop');
    const card = document.querySelector('.fm-dialog-card');
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    backdrop.dispatchEvent(new Event('click', { bubbles: true })); // click's target is the backdrop
    expect(document.querySelector('.fm-dialog-backdrop')).not.toBeNull();
  });
});
