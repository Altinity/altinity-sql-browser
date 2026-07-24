import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SHORTCUT_CATALOG, openShortcuts, handleKeydown, resetShortcutChord } from '../../src/ui/shortcuts.js';
import type { ShortcutKeydownEvent } from '../../src/ui/shortcuts.js';
import { makeApp } from '../helpers/fake-app.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('openShortcuts', () => {
  it('opens a modal and is idempotent while open', () => {
    const app = makeApp({ document });
    const r = openShortcuts(app);
    expect(app.state.shortcutsOpen.value).toBe(true);
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    expect(openShortcuts(app)).toBeNull(); // already open
    r!.close();
    r!.close(); // idempotent lifecycle handle
    expect(app.state.shortcutsOpen.value).toBe(false);
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });
  it('closes on Escape and ignores other keys', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(app.state.shortcutsOpen.value).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(app.state.shortcutsOpen.value).toBe(false);
  });
  it('closes when the backdrop is clicked', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    const backdrop = document.querySelector('.modal-backdrop')!;
    backdrop.dispatchEvent(new MouseEvent('mousedown'));
    backdrop.dispatchEvent(new Event('click'));
    expect(app.state.shortcutsOpen.value).toBe(false);
  });
  it('card click does not close', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    const card = document.querySelector('.modal-card')!;
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    card.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.shortcutsOpen.value).toBe(true);
  });
  it('a gesture starting on the card and ending on the backdrop does not close it (#110)', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    const backdrop = document.querySelector('.modal-backdrop')!;
    const card = document.querySelector('.modal-card')!;
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    backdrop.dispatchEvent(new Event('click', { bubbles: true })); // click's target is the backdrop
    expect(app.state.shortcutsOpen.value).toBe(true);
  });
  it('defaults document to global', () => {
    const app = makeApp();
    // `document` is optional on the real ShortcutsApp contract (openShortcuts
    // falls back to the global `document`) — fake-app.js's fixture always
    // sets it, so a targeted `Partial` view is what makes `delete` legal here.
    delete (app as Partial<typeof app>).document;
    openShortcuts(app);
    expect(document.querySelector('.modal-card')).not.toBeNull();
  });
  it('lists keyboard shortcuts plus a schema-tree gestures section', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    const text = document.querySelector('.modal-card')!.textContent;
    expect(text).toContain('Format active document');
    expect(text).toContain('SQL editor mode');
    expect(text).toContain('Spec editor mode');
    expect(document.querySelector('.modal-card .section-label')).not.toBeNull();
    expect(text).toContain('Double-click');
    expect(text).toContain('Shift-click');
  });
  it('renders Dashboard-only help from the shared catalog and supplies dialog accessibility', () => {
    const refresh = vi.fn(); const setDashboardStyle = vi.fn();
    const app = makeApp({ document, sqlRoute: { surface: 'dashboard', workspaceKey: 'w', mode: 'view' },
      surfaceCommands: { surface: 'dashboard', generation: 0, refresh, setDashboardStyle } });
    const invoke = document.createElement('button'); document.body.appendChild(invoke); invoke.focus();
    const opened = openShortcuts(app)!;
    const card = document.querySelector<HTMLElement>('.modal-card')!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(card.textContent).toContain('Refresh all tiles');
    expect(card.textContent).toContain('Open SQL Browser');
    const dashboardRows = [...card.querySelectorAll<HTMLElement>('.shortcut-section[aria-label="Dashboard"] .row')];
    expect(dashboardRows.map((row) => row.querySelector('.label')?.textContent))
      .toEqual(['Refresh all tiles', 'View mode', 'Edit mode', 'Style']);
    expect(dashboardRows.at(-1)?.textContent).toContain('G/F/R/2/3');
    expect(card.textContent).not.toContain('Grid Tiles');
    expect(card.textContent).not.toContain('Run query');
    expect(card.textContent).not.toContain('Schema tree');
    expect(card.querySelectorAll('kbd').length).toBeGreaterThan(0);
    const close = card.querySelector<HTMLButtonElement>('.close-btn')!;
    close.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    close.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    opened.close();
    expect(document.activeElement).toBe(invoke);
  });
  it('omits Dashboard refresh when no viewer session is mounted', () => {
    const app = makeApp({ document, sqlRoute: { surface: 'dashboard', workspaceKey: 'w', mode: 'view' }, surfaceCommands: null });
    openShortcuts(app);
    expect(document.querySelector('.modal-card')!.textContent).not.toContain('Refresh all tiles');
  });
});

describe('handleKeydown', () => {
  const ev = (over: Partial<ShortcutKeydownEvent> = {}): ShortcutKeydownEvent =>
    ({ preventDefault: vi.fn(), key: '', metaKey: false, ctrlKey: false, shiftKey: false, target: {}, ...over });

  it('gives every application-dispatched catalog entry executable metadata', () => {
    for (const command of SHORTCUT_CATALOG.filter((entry) => entry.dispatch === 'application')) {
      expect(command.run, command.id).toBeTypeOf('function');
      expect(!!command.matches || !!command.sequence, command.id).toBe(true);
    }
  });

  it('does not dispatch hidden Workbench shortcuts on a Dashboard route', () => {
    const app = makeApp({
      sqlRoute: { surface: 'dashboard', workspaceKey: 'w', mode: 'view' },
    });
    expect(handleKeydown(ev({ metaKey: true, key: 's' }), app)).toBeNull();
    expect(handleKeydown(ev({ metaKey: true, key: 'Enter' }), app)).toBeNull();
    expect(app.actions.save).not.toHaveBeenCalled();
    expect(app.actions.run).not.toHaveBeenCalled();
  });

  it('dispatches Dashboard refresh and mode navigation only for the current viewer generation', () => {
    const refresh = vi.fn(); const setDashboardStyle = vi.fn();
    const app = makeApp({ sqlRoute: { surface: 'dashboard', workspaceKey: 'sql_library', mode: 'edit' },
      captureSurfaceGeneration: () => 7,
      surfaceCommands: { surface: 'dashboard', generation: 7, refresh, setDashboardStyle },
      navigateSqlRoute: vi.fn(async () => {}) });
    expect(handleKeydown(ev({ metaKey: true, key: 'Enter' }), app)).toBe('dashboardRefresh');
    expect(refresh).toHaveBeenCalledOnce();
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('dashboardGridTiles');
    expect(setDashboardStyle).toHaveBeenLastCalledWith('grafana-grid');
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    expect(handleKeydown(ev({ key: '2' }), app)).toBe('dashboardColumns2');
    expect(setDashboardStyle).toHaveBeenLastCalledWith('columns-2');
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    expect(handleKeydown(ev({ key: 'v' }), app)).toBe('dashboardView');
    expect(app.navigateSqlRoute).toHaveBeenCalledWith({ surface: 'dashboard', workspaceKey: 'sql_library', mode: 'view' }, 'replace');
    (app.sqlRoute as { mode?: 'view' | 'edit' }).mode = 'view';
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    expect(handleKeydown(ev({ key: 'e' }), app)).toBe('dashboardEdit');
    expect(app.navigateSqlRoute).toHaveBeenLastCalledWith({ surface: 'dashboard', workspaceKey: 'sql_library', mode: 'edit' }, 'replace');
    const viewing = makeApp({ sqlRoute: { surface: 'dashboard', workspaceKey: 'sql_library', mode: 'view' } });
    expect(handleKeydown(ev({ key: 'g' }), viewing)).toBe('chord');
    expect(handleKeydown(ev({ key: 'v' }), viewing)).toBeNull();
    const editing = makeApp({ sqlRoute: { surface: 'dashboard', workspaceKey: 'sql_library', mode: 'edit' } });
    expect(handleKeydown(ev({ key: 'g' }), editing)).toBe('chord');
    expect(handleKeydown(ev({ key: 'e' }), editing)).toBeNull();
    app.surfaceCommands = { surface: 'dashboard', generation: 6, refresh, setDashboardStyle };
    expect(handleKeydown(ev({ metaKey: true, key: 'Enter' }), app)).toBeNull();
  });

  it('selects every Dashboard style through its G chord', () => {
    const setDashboardStyle = vi.fn();
    const app = makeApp({
      sqlRoute: { surface: 'dashboard', workspaceKey: 'sql_library', mode: 'view' },
      surfaceCommands: { surface: 'dashboard', generation: 0, refresh: vi.fn(), setDashboardStyle },
    });
    for (const [key, style, result] of [
      ['g', 'grafana-grid', 'dashboardGridTiles'], ['f', 'full', 'dashboardFullView'],
      ['r', 'report', 'dashboardReport'], ['2', 'columns-2', 'dashboardColumns2'], ['3', 'columns-3', 'dashboardColumns3'],
    ] as const) {
      expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
      expect(handleKeydown(ev({ key }), app)).toBe(result);
      expect(setDashboardStyle).toHaveBeenLastCalledWith(style);
    }
  });

  it('routes the G chord by current surface, and resets it on mismatch, timeout, blur and stale generation', () => {
    vi.useFakeTimers();
    const navigateSqlRoute = vi.fn(async () => {});
    let generation = 1;
    const app = makeApp({ navigateSqlRoute, captureSurfaceGeneration: () => generation });
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    // A repeated G deliberately restarts the chord's expiration window.
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    expect(handleKeydown(ev({ key: 'x' }), app)).toBeNull();
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    generation = 2;
    expect(handleKeydown(ev({ key: 'd' }), app)).toBeNull();
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    expect(handleKeydown(ev({ key: 'd' }), app)).toBe('openDashboard');
    expect(navigateSqlRoute).toHaveBeenLastCalledWith({ surface: 'dashboard', workspaceKey: 'sql_library', mode: 'edit' }, 'push');
    app.sqlRoute = { surface: 'dashboard', workspaceKey: 'sql_library', mode: 'view' };
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    expect(handleKeydown(ev({ key: 'w' }), app)).toBe('openWorkbench');
    expect(navigateSqlRoute).toHaveBeenLastCalledWith({ surface: 'workspace', workspaceKey: 'sql_library' }, 'push');
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    window.dispatchEvent(new Event('blur'));
    expect(handleKeydown(ev({ key: 'w' }), app)).toBeNull();
    expect(handleKeydown(ev({ key: 'g' }), app)).toBe('chord');
    vi.advanceTimersByTime(1500);
    expect(handleKeydown(ev({ key: 'w' }), app)).toBeNull();
    resetShortcutChord(app);
    vi.useRealTimers();
  });

  it('keeps surface actions behind keyboard-owning overlays and ignores plain keys while typing', () => {
    const refresh = vi.fn(); const setDashboardStyle = vi.fn();
    const app = makeApp({ sqlRoute: { surface: 'dashboard', workspaceKey: 'sql_library', mode: 'view' },
      surfaceCommands: { surface: 'dashboard', generation: 0, refresh, setDashboardStyle } });
    app.keyboardOwner = { kind: 'popover' };
    expect(handleKeydown(ev({ metaKey: true, key: 'Enter' }), app)).toBeNull();
    app.keyboardOwner = null;
    expect(handleKeydown(ev({ key: 'g', target: { tagName: 'SELECT' } }), app)).toBeNull();
    expect(handleKeydown(ev({ key: 'g', target: { getAttribute: () => 'textbox' } }), app)).toBeNull();
    expect(handleKeydown(ev({ key: 'g', target: {
      closest: (selector) => selector.includes('[role="textbox"]') ? document.body : null,
    } }), app)).toBeNull();
    app.keyboardOwner = { kind: 'modal' };
    expect(handleKeydown(ev({ key: 'x' }), app)).toBeNull();
  });

  it('fails closed for every Workbench action shortcut while the route is loading', () => {
    const app = makeApp({ workspaceRouteStatus: 'loading' });
    const shortcuts = [
      { metaKey: true, key: 'Enter' },
      { metaKey: true, shiftKey: true, key: 'Enter' },
      { metaKey: true, key: 's' },
      { metaKey: true, shiftKey: true, key: 's' },
      { metaKey: true, altKey: true, key: '1' },
      { metaKey: true, altKey: true, key: '2' },
    ];
    for (const shortcut of shortcuts) {
      const event = ev(shortcut);
      expect(handleKeydown(event, app)).toBeNull();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    app.activeTab().editorMode = 'spec';
    const specFormat = ev({ metaKey: true, shiftKey: true, key: 'Enter' });
    expect(handleKeydown(specFormat, app)).toBeNull();
    expect(specFormat.preventDefault).not.toHaveBeenCalled();
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(app.actions.save).not.toHaveBeenCalled();
    expect(app.actions.share).not.toHaveBeenCalled();
    expect(app.actions.formatQuery).not.toHaveBeenCalled();
    expect(app.actions.formatSpec).not.toHaveBeenCalled();
    expect(app.actions.setEditorMode).not.toHaveBeenCalled();
  });

  it('fails closed when a ready Workbench route key does not match the projected workspace', () => {
    const app = makeApp({
      sqlRoute: { surface: 'workspace', workspaceKey: 'another-workspace' },
    });
    expect(handleKeydown(ev({ metaKey: true, key: 'Enter' }), app)).toBeNull();
    expect(app.actions.run).not.toHaveBeenCalled();
  });

  it('runs a SQL document when signed in', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ metaKey: true, key: 'Enter' }), app)).toBe('run');
    expect(app.actions.run).toHaveBeenCalledOnce();
  });

  it('fails closed for every application action when signed out', () => {
    const app = makeApp({ conn: { isSignedIn: () => false } });
    for (const event of [
      { metaKey: true, key: 'Enter' }, { metaKey: true, key: 's' },
      { metaKey: true, shiftKey: true, key: 'Enter' }, { key: 'g' }, { key: '?' },
    ]) expect(handleKeydown(ev(event), app)).toBeNull();
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(app.actions.save).not.toHaveBeenCalled();
    expect(app.actions.formatQuery).not.toHaveBeenCalled();
  });
  it('a key the editor already consumed (defaultPrevented) never triggers a global action', () => {
    const app = makeApp();
    app.state.running.value = true;
    // e.g. Esc that just closed the CM6 completion popup / search panel (#21)
    expect(handleKeydown(ev({ key: 'Escape', defaultPrevented: true }), app)).toBeNull();
    expect(app.actions.cancel).not.toHaveBeenCalled();
    expect(handleKeydown(ev({ metaKey: true, key: 'Enter', defaultPrevented: true }), app)).toBeNull();
    expect(app.actions.run).not.toHaveBeenCalled();
  });
  it('Escape cancels a running query, and is a no-op otherwise', () => {
    const app = makeApp();
    app.state.running.value = false;
    expect(handleKeydown(ev({ key: 'Escape' }), app)).toBeNull();
    expect(app.actions.cancel).not.toHaveBeenCalled();
    app.state.running.value = true;
    expect(handleKeydown(ev({ key: 'Escape' }), app)).toBe('cancel');
    expect(app.actions.cancel).toHaveBeenCalled();
  });
  it('Escape closes an open docs pane FIRST — from anywhere — before cancelling a running query (#60)', () => {
    const app = makeApp();
    app.closeDocPane = vi.fn(() => true); // a pane was open and got closed
    app.state.running.value = true;
    expect(handleKeydown(ev({ key: 'Escape' }), app)).toBe('close-doc-pane');
    expect(app.actions.cancel).not.toHaveBeenCalled(); // layered: the second Esc cancels
    app.closeDocPane = vi.fn(() => false); // no pane open — falls through to cancel
    expect(handleKeydown(ev({ key: 'Escape' }), app)).toBe('cancel');
    expect(app.actions.cancel).toHaveBeenCalled();
  });
  it('⌘T / ⌘W are no longer intercepted (browser keeps them)', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ metaKey: true, key: 't' }), app)).toBeNull();
    expect(handleKeydown(ev({ metaKey: true, key: 'w' }), app)).toBeNull();
    expect(app.actions.newTab).not.toHaveBeenCalled();
    expect(app.actions.closeTab).not.toHaveBeenCalled();
  });
  it('⌘⇧↵ formats the query; gated by sign-in', () => {
    const app = makeApp();
    const e = ev({ metaKey: true, shiftKey: true, key: 'Enter' });
    expect(handleKeydown(e, app)).toBe('formatQuery');
    expect(app.actions.formatQuery).toHaveBeenCalled();
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    const out = makeApp({ conn: { isSignedIn: () => false } });
    expect(handleKeydown(ev({ metaKey: true, shiftKey: true, key: 'Enter' }), out)).toBeNull();
  });
  it('Spec mode blocks Run and routes document formatting to the Spec editor', () => {
    const app = makeApp();
    app.activeTab().editorMode = 'spec';
    const run = ev({ metaKey: true, key: 'Enter' });
    expect(handleKeydown(run, app)).toBeNull();
    expect(run.preventDefault).not.toHaveBeenCalled();
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(handleKeydown(ev({ metaKey: true, shiftKey: true, key: 'Enter' }), app)).toBe('formatSpec');
    expect(app.actions.formatSpec).toHaveBeenCalled();
    expect(app.actions.formatQuery).not.toHaveBeenCalled();
  });
  it('⌘⌥1/2 switches the injected document mode', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ metaKey: true, altKey: true, key: '1' }), app)).toBe('sqlMode');
    expect(app.actions.setEditorMode).toHaveBeenLastCalledWith('sql');
    expect(handleKeydown(ev({ ctrlKey: true, altKey: true, key: '2' }), app)).toBe('specMode');
    expect(app.actions.setEditorMode).toHaveBeenLastCalledWith('spec');
  });

  it('does not switch editor mode while signed out', () => {
    const app = makeApp({ conn: { isSignedIn: () => false } });
    const e = ev({ metaKey: true, altKey: true, key: '1' });
    expect(handleKeydown(e, app)).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(app.actions.setEditorMode).not.toHaveBeenCalled();
  });
  it('⌘⇧S shares only from SQL mode; ⌘S saves either document', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ metaKey: true, shiftKey: true, key: 'S' }), app)).toBe('share');
    expect(handleKeydown(ev({ metaKey: true, key: 's' }), app)).toBe('save');
    app.activeTab().editorMode = 'spec';
    const specShare = ev({ metaKey: true, shiftKey: true, key: 's' });
    expect(handleKeydown(specShare, app)).toBeNull();
    expect(specShare.preventDefault).not.toHaveBeenCalled();
    expect(app.actions.share).toHaveBeenCalledTimes(1);
    expect(handleKeydown(ev({ metaKey: true, key: 's' }), app)).toBe('save');
    expect(app.actions.save).toHaveBeenCalledTimes(2);
    const out = makeApp({ conn: { isSignedIn: () => false } });
    expect(handleKeydown(ev({ metaKey: true, shiftKey: true, key: 's' }), out)).toBeNull();
    expect(handleKeydown(ev({ metaKey: true, key: 's' }), out)).toBeNull();
  });
  it('? opens shortcuts unless typing in a field', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ key: '?' }), app)).toBe('shortcuts');
    expect(handleKeydown(ev({ key: '?', target: { tagName: 'INPUT' } }), app)).toBeNull();
    expect(handleKeydown(ev({ key: '?', target: { isContentEditable: true } }), app)).toBeNull();
    const out = makeApp({ conn: { isSignedIn: () => false } });
    expect(handleKeydown(ev({ key: '?' }), out)).toBeNull();
  });
  it('returns null for unhandled keys', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ key: 'x' }), app)).toBeNull();
    expect(handleKeydown(ev({ key: '?', target: null }), makeApp())).toBe('shortcuts');
  });

  it('⌘A selects a raw result pane even when it is not focused (macOS body target)', () => {
    const app = makeApp();
    const box = document.createElement('div');
    box.className = 'raw-text-view';
    box.textContent = 'a\tb\nc\td';
    document.body.appendChild(box);
    // target is <body> (pane not focused — the macOS WebKit case), pane on screen
    const e = ev({ metaKey: true, key: 'a', target: document.body });
    expect(handleKeydown(e, app)).toBe('selectAll');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(box.ownerDocument.defaultView!.getSelection()!.toString()).toBe('a\tb\nc\td');
  });

  it('⌘A selects the cell-detail drawer text (and wins over the pane behind it)', () => {
    const app = makeApp();
    const pane = document.createElement('div');
    pane.className = 'raw-text-view';
    pane.textContent = 'pane text';
    document.body.appendChild(pane);
    const pre = document.createElement('pre');
    pre.className = 'cd-pre';
    pre.textContent = '{"version":1}';
    document.body.appendChild(pre);
    const e = ev({ metaKey: true, key: 'a', target: document.body });
    expect(handleKeydown(e, app)).toBe('selectAll');
    expect(pre.ownerDocument.defaultView!.getSelection()!.toString()).toBe('{"version":1}');
  });

  it('⌘A while editing keeps the native select-all (editor / inputs)', () => {
    const app = makeApp();
    document.body.appendChild(document.createElement('div')).className = 'raw-text-view';
    const ta = document.createElement('textarea');
    const e = ev({ metaKey: true, key: 'A', target: ta });
    expect(handleKeydown(e, app)).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(handleKeydown(ev({ metaKey: true, key: 'a', target: { tagName: 'INPUT' } }), app)).toBeNull();
    expect(handleKeydown(ev({ metaKey: true, key: 'a', target: { isContentEditable: true } }), app)).toBeNull();
  });

  it('⌘A with no raw pane on screen falls through to native select-all', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ metaKey: true, key: 'a', target: null }), app)).toBeNull();
  });
});
