import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assignLibraryQueryToPanel } from '../../src/application/library-assignment-service.js';
import { openLibraryAssignMenu } from '../../src/ui/library-assign-menu.js';
import { closeOpenMenus } from '../../src/ui/menu.js';
import { makeApp } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';
import type { App } from '../../src/ui/app.types.js';
import { groupStateKey, readTreeUi } from '../../src/core/dashboard-tree-ui-state.js';

const query = savedQuery({ id: 'library-q', name: 'Orders', sql: 'SELECT * FROM orders' });
const dashboard = (id: string, title: string) => ({
  documentVersion: 2 as const,
  id,
  title,
  revision: 1,
  layout: { type: 'flow' as const, version: 1 as const, preset: 'report' as const, items: {} },
  tiles: [],
});
const workspace = (): StoredWorkspaceV5 => ({
  storageVersion: 5,
  id: 'workspace-1',
  key: 'workspace',
  name: 'Workspace',
  queries: [query],
  dashboards: [dashboard('dashboard-a', 'Alpha'), dashboard('dashboard-b', 'Beta')],
});
const trigger = (): HTMLButtonElement => {
  const button = document.createElement('button');
  document.body.appendChild(button);
  return button;
};
const click = (element: Element): void => {
  element.dispatchEvent(new Event('click', { bubbles: true }));
};
const key = (keyName: string): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  closeOpenMenus(document);
  document.body.replaceChildren();
});

describe('openLibraryAssignMenu', () => {
  it('lists dashboards in workspace order and owns keyboard focus through Escape', () => {
    const app = makeApp();
    app.currentWorkspace = workspace();
    const release = vi.fn();
    app.acquireKeyboardOwner = vi.fn(() => release);
    const button = trigger();

    const handle = openLibraryAssignMenu(app, query, button);
    const items = [...handle.el.querySelectorAll<HTMLButtonElement>('.fm-item')];
    expect(items.map((item) => item.querySelector('.fm-label')?.textContent))
      .toEqual(['Alpha', 'Beta']);
    expect(items.map((item) => item.querySelector('.fm-meta')?.textContent))
      .toEqual(['0 tiles · oard-a', '0 tiles · oard-b']);
    expect(handle.el.getAttribute('aria-label')).toBe('Choose a dashboard for Orders');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(app.acquireKeyboardOwner).toHaveBeenCalledWith('menu');

    items[0].focus();
    key('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key('ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    key('Escape');
    expect(handle.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('closes Dashboard selection before opening the anchored Add/Cancel stage', async () => {
    const app = makeApp();
    app.currentWorkspace = workspace();
    const button = trigger();
    const first = openLibraryAssignMenu(app, query, button);

    click(first.el.querySelectorAll('.fm-item')[1]);
    expect(first.el.isConnected).toBe(false);
    const second = document.querySelector<HTMLElement>('.library-assign-menu')!;
    expect(document.querySelectorAll('.library-assign-menu')).toHaveLength(1);
    expect(second.textContent).toContain('Add “Orders” to “Beta” as a new panel');
    expect(second.getAttribute('aria-label')).toBe('Confirm adding Orders to Beta');
    expect([...second.querySelectorAll('.fm-item')].map((item) => item.textContent))
      .toEqual(['Add', 'Cancel']);

    await flush();
    const cancel = second.querySelectorAll<HTMLButtonElement>('.fm-item')[1];
    expect(document.activeElement).toBe(cancel);
    click(cancel);
    expect(second.isConnected).toBe(false);
    expect(document.activeElement).toBe(button);

    const reopened = openLibraryAssignMenu(app, query, button);
    click(reopened.el.querySelectorAll('.fm-item')[1]);
    const secondReopened = document.querySelector<HTMLElement>('.library-assign-menu')!;
    key('Escape');
    expect(secondReopened.isConnected).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('commits a byte-identical candidate through the same service as drag/drop', async () => {
    const base = workspace();
    const app = makeApp();
    app.currentWorkspace = structuredClone(base);
    app.genId = vi.fn()
      .mockReturnValueOnce('new-query')
      .mockReturnValueOnce('new-tile');
    let chooserCandidate: StoredWorkspaceV5 | null = null;
    app.mutateWorkspace = (async (transform: Parameters<App['mutateWorkspace']>[0]) => {
      const input = await transform(structuredClone(base));
      chooserCandidate = input?.candidate ?? null;
      if (!input?.candidate) return { ok: false as const, aborted: true as const, data: input?.data };
      return {
        ok: true as const, workspace: input.candidate, dashboardRevision: 2, data: input.data,
      };
    }) as App['mutateWorkspace'];
    app.onWorkspaceExternallyChanged = vi.fn();
    app.openSavedQuery = vi.fn();

    const first = openLibraryAssignMenu(app, query, trigger());
    click(first.el.querySelectorAll('.fm-item')[0]);
    const second = document.querySelector<HTMLElement>('.library-assign-menu')!;
    click(second.querySelectorAll('.fm-item')[0]);
    await flush();

    let serviceCandidate: StoredWorkspaceV5 | null = null;
    const serviceOutcome = await assignLibraryQueryToPanel({
      mutateWorkspace: async (transform) => {
        const input = await transform(structuredClone(base));
        serviceCandidate = input?.candidate ?? null;
        if (!input?.candidate) return { ok: false, aborted: true, data: input?.data };
        return { ok: true, workspace: input.candidate, dashboardRevision: 2, data: input.data };
      },
      onWorkspaceExternallyChanged: vi.fn(),
      genId: vi.fn()
        .mockReturnValueOnce('new-query')
        .mockReturnValueOnce('new-tile'),
    }, { kind: 'library-query', workspaceId: 'workspace-1', queryId: 'library-q' }, 'dashboard-a');

    expect(serviceOutcome.ok).toBe(true);
    const committed = chooserCandidate as StoredWorkspaceV5 | null;
    if (committed === null) throw new Error('chooser did not build a candidate');
    expect(JSON.stringify(committed)).toBe(JSON.stringify(serviceCandidate));
    expect(committed.queries[0]).toEqual(query);
    expect(committed.queries[1]?.id).toBe('new-query');
    expect(committed.dashboards[0].tiles).toEqual([
      { id: 'new-tile', queryId: 'new-query' },
    ]);
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledWith({
      workspace: committed, queriesChanged: true,
    });
    expect(app.state.upperRole.value).toBe('dashboards');
    const treeUi = readTreeUi(app.state.dashboardTreeUi, 'workspace-1');
    expect(treeUi.expandedDashboardIds.has('dashboard-a')).toBe(true);
    expect(treeUi.expandedGroups.has(groupStateKey('dashboard-a', 'panels'))).toBe(true);
    expect(treeUi.keyboardRowKey).toBe('workspace-1:dashboard-a:tile:new-tile');
    expect(app.openSavedQuery).toHaveBeenCalledWith('new-query');
  });

  it('reports a refused assignment without opening a query', async () => {
    const app = makeApp();
    app.currentWorkspace = workspace();
    app.openSavedQuery = vi.fn();
    app.mutateWorkspace = vi.fn(async () => ({
      ok: false as const,
      aborted: true as const,
      data: { status: 'declined' as const, reason: 'dashboard-missing' as const },
    })) as App['mutateWorkspace'];

    const first = openLibraryAssignMenu(app, query, trigger());
    click(first.el.querySelectorAll('.fm-item')[0]);
    click(document.querySelectorAll('.library-assign-menu .fm-item')[0]);
    await flush();

    expect(app.openSavedQuery).not.toHaveBeenCalled();
    expect(document.querySelector('.share-toast')?.textContent)
      .toBe('That dashboard is no longer available — nothing was assigned');
  });

  it('notifies the live renderer but suppresses stale navigation after an in-flight surface change', async () => {
    const base = workspace();
    const app = makeApp();
    app.currentWorkspace = base;
    app.captureSurfaceGeneration = vi.fn(() => 4);
    let currentGeneration = true;
    app.isSurfaceGenerationCurrent = vi.fn(() => currentGeneration);
    app.openSavedQuery = vi.fn();
    const oldHook = vi.fn();
    const liveHook = vi.fn();
    app.onWorkspaceExternallyChanged = oldHook;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const underway = new Promise<void>((resolve) => { started = resolve; });
    app.mutateWorkspace = (async (transform: Parameters<App['mutateWorkspace']>[0]) => {
      const input = await transform(structuredClone(base));
      if (!input?.candidate) return { ok: false as const, aborted: true as const, data: input?.data };
      started();
      await gate;
      return {
        ok: true as const, workspace: input.candidate, dashboardRevision: 2, data: input.data,
      };
    }) as App['mutateWorkspace'];

    const first = openLibraryAssignMenu(app, query, trigger());
    click(first.el.querySelectorAll('.fm-item')[0]);
    click(document.querySelectorAll('.library-assign-menu .fm-item')[0]);
    await underway;
    app.onWorkspaceExternallyChanged = liveHook;
    currentGeneration = false;
    release();
    await flush();

    expect(oldHook).not.toHaveBeenCalled();
    expect(liveHook).toHaveBeenCalledTimes(1);
    expect(app.openSavedQuery).not.toHaveBeenCalled();
    expect(document.querySelector('.share-toast')).toBeNull();
  });

  it('still opens the owned copy when the live renderer refresh itself advances generation', async () => {
    const base = workspace();
    const app = makeApp();
    app.currentWorkspace = base;
    let generation = 8;
    app.captureSurfaceGeneration = vi.fn(() => generation);
    app.isSurfaceGenerationCurrent = vi.fn((captured) => captured === generation);
    app.openSavedQuery = vi.fn();
    app.onWorkspaceExternallyChanged = vi.fn(() => { generation += 1; });
    app.mutateWorkspace = (async (transform: Parameters<App['mutateWorkspace']>[0]) => {
      const input = await transform(structuredClone(base));
      if (!input?.candidate) return { ok: false as const, aborted: true as const, data: input?.data };
      return {
        ok: true as const, workspace: input.candidate, dashboardRevision: 2, data: input.data,
      };
    }) as App['mutateWorkspace'];

    const first = openLibraryAssignMenu(app, query, trigger());
    click(first.el.querySelectorAll('.fm-item')[0]);
    click(document.querySelectorAll('.library-assign-menu .fm-item')[0]);
    await flush();

    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledTimes(1);
    expect(app.openSavedQuery).toHaveBeenCalledWith('gen-1');
  });

  it('keeps an explanatory chooser when no workspace or Dashboard is available', () => {
    const app = makeApp();
    const button = trigger();
    const menu = openLibraryAssignMenu(app, query, button);

    expect(menu.el.textContent).toContain('Create or open a dashboard');
    const cancel = menu.el.querySelector<HTMLButtonElement>('.fm-item')!;
    expect(cancel.textContent).toBe('Cancel');
    click(cancel);
    expect(menu.el.isConnected).toBe(false);
  });

  it('shows duplicate Dashboard ids but disables their ambiguous destinations', () => {
    const app = makeApp();
    const duplicate = workspace();
    duplicate.dashboards = [
      dashboard('same', 'First same id'),
      dashboard('same', 'Second same id'),
    ];
    app.currentWorkspace = duplicate;
    const menu = openLibraryAssignMenu(app, query, trigger());
    const items = [...menu.el.querySelectorAll<HTMLButtonElement>('.fm-item')];

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(menu.el.textContent).toContain('Two dashboards share this id');
    expect(items.map((item) => item.querySelector('.fm-meta')?.textContent)).toEqual([
      '0 tiles · same · duplicate 1/2',
      '0 tiles · same · duplicate 2/2',
    ]);
    click(items[0]);
    expect(document.querySelectorAll('.library-assign-menu')).toHaveLength(1);
  });

  it('distinguishes duplicate titles even when the shortest id tails collide', () => {
    const app = makeApp();
    const sameTitles = workspace();
    sameTitles.dashboards = [
      dashboard('sales-abcdef', 'Operations'),
      dashboard('ops-abcdef', 'Operations'),
    ];
    app.currentWorkspace = sameTitles;
    const menu = openLibraryAssignMenu(app, query, trigger());
    const items = [...menu.el.querySelectorAll<HTMLButtonElement>('.fm-item')];

    expect(items.map((item) => item.querySelector('.fm-label')?.textContent))
      .toEqual(['Operations', 'Operations']);
    const metas = items.map((item) => item.querySelector('.fm-meta')?.textContent);
    expect(new Set(metas).size).toBe(2);
    expect(metas).not.toContain('0 tiles · abcdef');
  });

  it('uses canonical fallback names for a nameless query and blank Dashboard title', () => {
    const app = makeApp();
    const nameless = savedQuery({ id: 'nameless', name: '   ', sql: 'SELECT 1' });
    const blankNames = workspace();
    blankNames.queries = [nameless];
    blankNames.dashboards = [dashboard('blank-title', '   ')];
    app.currentWorkspace = blankNames;
    const button = trigger();
    const choose = openLibraryAssignMenu(app, nameless, button);

    expect(choose.el.getAttribute('aria-label')).toBe('Choose a dashboard for Untitled');
    expect(choose.el.querySelector('.fm-label')?.textContent).toBe('Untitled dashboard');
    click(choose.el.querySelector('.fm-item')!);
    const confirm = document.querySelector<HTMLElement>('.library-assign-menu')!;
    expect(confirm.getAttribute('aria-label'))
      .toBe('Confirm adding Untitled to Untitled dashboard');
    expect(confirm.textContent)
      .toContain('Add “Untitled” to “Untitled dashboard” as a new panel');
  });
});
