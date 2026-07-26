import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeVariableEditor, commitVariableConfig, createTextareaVariableEditor,
  isVariableEditorOpen, openVariableEditor,
  type VariableEditorApp, type VariableEditorFactory,
} from '../../src/ui/variable-editor.js';
import type { App } from '../../src/ui/app.types.js';
import type {
  DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../src/generated/json-schema.types.js';

const query = (id: string, sql: string): SavedQueryV2 => ({
  id, sql, specVersion: 1, spec: { specVersion: 1, name: id.toUpperCase() },
});

const dashboard = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id: 'd', title: 'D', revision: 3,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [{ id: 't1', queryId: 'q1' }],
  ...over,
});

const workspace = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'ops', name: 'Ops',
  queries: [query('q1', 'SELECT * FROM t WHERE c = {country:String}')],
  dashboards: [dashboard()],
  ...over,
});

/** A fake app whose `mutateWorkspace` faithfully mirrors the real primitive's
 *  shape — read the latest committed aggregate, run the transform, record what it
 *  would commit — so a test can assert the exact candidate. */
function makeApp(over: Partial<VariableEditorApp> = {}) {
  const latest = (over.currentWorkspace ?? workspace()) as StoredWorkspaceV5;
  const committed: (StoredWorkspaceV5 | null)[] = [];
  const mutateWorkspace: App['mutateWorkspace'] = async (transform) => {
    const input = await transform(latest);
    const candidate = input === null ? null : input.candidate;
    committed.push(candidate);
    if (candidate === null) return { ok: false, aborted: true };
    return { ok: true, workspace: candidate, dashboardRevision: null };
  };
  const app: VariableEditorApp = {
    document,
    currentWorkspace: latest,
    mutateWorkspace: vi.fn(mutateWorkspace) as App['mutateWorkspace'],
    ...over,
  };
  return {
    app,
    committed,
    /** The Dashboard document the last transform would have committed. */
    lastDashboard: (): DashboardDocumentV2 => committed[committed.length - 1]!.dashboards[0],
  };
}

const panel = (): HTMLElement => document.querySelector<HTMLElement>('.varedit-panel')!;
const input = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('.varedit-input')!;
const click = (selector: string): void => document.querySelector<HTMLElement>(selector)!.click();
const escape = (target: EventTarget): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
/** Let the (async) mutateWorkspace transform run. */
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

// The open editor is registered per DOCUMENT, so a test that leaves one open would
// leak it into the next through the shared happy-dom document — exactly as
// doc-pane.test.ts closes its pane at the end of each case.
const TEARDOWN: VariableEditorApp = {
  document,
  currentWorkspace: null,
  mutateWorkspace: (async () => ({ ok: false, aborted: true })) as App['mutateWorkspace'],
};

beforeEach(() => {
  closeVariableEditor(TEARDOWN);
  document.body.innerHTML = '';
});

describe('openVariableEditor — identity and contents', () => {
  it('opens a non-modal drawer naming the variable, with no backdrop', () => {
    const { app } = makeApp();
    openVariableEditor(app, 'd', 'country');
    expect(panel()).not.toBeNull();
    expect(panel().getAttribute('role')).toBe('complementary');
    expect(panel().getAttribute('aria-label')).toBe('Option SQL for country');
    // Non-modal, exactly like the documentation pane: no backdrop at all.
    expect(document.querySelector('.cd-backdrop')).toBeNull();
    expect(document.querySelector('.varedit-title-name')!.textContent).toBe('country');
    expect(isVariableEditorOpen(app)).toBe(true);
  });

  it('shows the variable NAME and its INFERRED type', () => {
    const { app } = makeApp();
    openVariableEditor(app, 'd', 'country');
    expect(document.querySelector('.varedit-name')!.textContent).toBe('country');
    expect(document.querySelector('.varedit-type')!.textContent).toBe('String');
  });

  it('shows every disagreeing type, and a note, for a CONFLICTED variable', () => {
    const { app } = makeApp({
      currentWorkspace: workspace({
        queries: [
          query('q1', 'SELECT 1 WHERE c = {customer_id:String}'),
          query('q2', 'SELECT 1 WHERE c = {customer_id:UInt64}'),
        ],
        dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }] })],
      }),
    });
    openVariableEditor(app, 'd', 'customer_id');
    expect(document.querySelector('.varedit-type')!.textContent).toBe('String | UInt64');
    expect(document.querySelector('.varedit-note')!.textContent).toContain('incompatible types');
  });

  it('says "type unknown" for an orphan whose configuration recorded no type', () => {
    const { app } = makeApp({
      currentWorkspace: workspace({
        queries: [query('q1', 'SELECT 1')],
        dashboards: [dashboard({ variableConfigs: { region: { sql: 'SELECT r, r' } } })],
      }),
    });
    openVariableEditor(app, 'd', 'region');
    expect(document.querySelector('.varedit-type')!.textContent).toBe('type unknown');
  });

  it('has NO panel visualisation selector and NO Dashboard role selector', () => {
    const { app } = makeApp();
    openVariableEditor(app, 'd', 'country');
    // The whole surface is: identity read-out, the SQL editor, and Cancel/Save.
    expect(panel().querySelectorAll('select')).toHaveLength(0);
    expect(panel().querySelectorAll('input')).toHaveLength(0);
    expect([...panel().querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['', 'Cancel', 'Save']); // the ✕ close button carries an icon, no text
  });

  it('opens EMPTY for a newly inferred variable that has no stored SQL', () => {
    const { app } = makeApp();
    openVariableEditor(app, 'd', 'country');
    expect(input().value).toBe('');
  });

  it('opens on the STORED SQL when the variable is configured', () => {
    const { app } = makeApp({
      currentWorkspace: workspace({
        dashboards: [dashboard({ variableConfigs: { country: { sql: 'SELECT c, c FROM countries' } } })],
      }),
    });
    openVariableEditor(app, 'd', 'country');
    expect(input().value).toBe('SELECT c, c FROM countries');
  });

  it('opens nothing at all for a name that no longer resolves', () => {
    // Reachable from a click arbitrated against rows a repaint has already replaced.
    const { app } = makeApp();
    openVariableEditor(app, 'd', 'not_a_variable');
    expect(panel()).toBeNull();
    expect(isVariableEditorOpen(app)).toBe(false);
    // ...and likewise for a Dashboard that is gone.
    openVariableEditor(app, 'gone', 'country');
    expect(panel()).toBeNull();
  });

  it('replaces its own instance rather than stacking a second panel', () => {
    const { app } = makeApp({
      currentWorkspace: workspace({
        queries: [query('q1', 'SELECT 1 WHERE a = {country:String} AND b = {year:UInt16}')],
      }),
    });
    openVariableEditor(app, 'd', 'country');
    const first = panel();
    openVariableEditor(app, 'd', 'year');
    expect(document.querySelectorAll('.varedit-panel')).toHaveLength(1);
    expect(panel()).not.toBe(first);
    expect(document.querySelector('.varedit-name')!.textContent).toBe('year');
  });

  it('falls back to the ambient document when the app carries none', () => {
    const { app } = makeApp();
    openVariableEditor({ ...app, document: undefined }, 'd', 'country');
    expect(document.querySelector('.varedit-panel')).not.toBeNull();
    expect(isVariableEditorOpen({ ...app, document: undefined })).toBe(true);
    closeVariableEditor({ ...app, document: undefined });
    expect(document.querySelector('.varedit-panel')).toBeNull();
  });
});

describe('openVariableEditor — closing', () => {
  it('closes on the ✕ button, on Cancel, and destroys the editor surface', () => {
    const { app } = makeApp();
    openVariableEditor(app, 'd', 'country');
    click('.varedit-close');
    expect(panel()).toBeNull();
    expect(input()).toBeNull();
    expect(isVariableEditorOpen(app)).toBe(false);

    openVariableEditor(app, 'd', 'country');
    click('.varedit-cancel');
    expect(panel()).toBeNull();
  });

  it('closes on Escape while focus is INSIDE the panel, and swallows that key', () => {
    const { app } = makeApp();
    openVariableEditor(app, 'd', 'country');
    input().focus();
    const event = escape(input());
    // Swallowed in the capture phase so shortcuts.ts's global Escape (cancel the
    // running query) cannot ALSO fire.
    expect(event.defaultPrevented).toBe(true);
    expect(panel()).toBeNull();
  });

  it('ignores Escape while focus is OUTSIDE the panel, and every other key inside', () => {
    const { app } = makeApp();
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    openVariableEditor(app, 'd', 'country');
    outside.focus();
    escape(outside);
    expect(panel()).not.toBeNull();
    input().focus();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    expect(panel()).not.toBeNull();
  });

  it('restores focus to whatever opened it', () => {
    const { app } = makeApp();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    openVariableEditor(app, 'd', 'country');
    // The editor surface takes focus on open...
    expect(document.activeElement).toBe(input());
    closeVariableEditor(app);
    // ...and hands it back on close.
    expect(document.activeElement).toBe(opener);
  });

  it('survives an initiator that has since left the document', () => {
    const { app } = makeApp();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    openVariableEditor(app, 'd', 'country');
    opener.remove();
    expect(() => closeVariableEditor(app)).not.toThrow();
  });

  it('is a no-op when nothing is open', () => {
    const { app } = makeApp();
    expect(() => closeVariableEditor(app)).not.toThrow();
    expect(isVariableEditorOpen(app)).toBe(false);
  });
});

describe('openVariableEditor — saving', () => {
  it('stores the SQL plus the agreed type, touching nothing else', async () => {
    const { app, lastDashboard } = makeApp({
      currentWorkspace: workspace({
        dashboards: [dashboard({ variableConfigs: { other: { sql: 'SELECT o, o' } } })],
      }),
    });
    openVariableEditor(app, 'd', 'country');
    input().value = 'SELECT c, c FROM countries';
    click('.varedit-save');
    await settle();
    const next = lastDashboard();
    expect(next.variableConfigs).toEqual({
      other: { sql: 'SELECT o, o' },
      country: { sql: 'SELECT c, c FROM countries', lastKnownType: 'String' },
    });
    // No panel query is edited, and the revision advances exactly once.
    expect(next.tiles).toEqual([{ id: 't1', queryId: 'q1' }]);
    expect(next.revision).toBe(4);
    expect(panel()).toBeNull();
  });

  it('records NO lastKnownType when the type is not agreed', async () => {
    const { app, lastDashboard } = makeApp({
      currentWorkspace: workspace({
        queries: [
          query('q1', 'SELECT 1 WHERE c = {customer_id:String}'),
          query('q2', 'SELECT 1 WHERE c = {customer_id:UInt64}'),
        ],
        dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }] })],
      }),
    });
    openVariableEditor(app, 'd', 'customer_id');
    input().value = 'SELECT id, id FROM customers';
    click('.varedit-save');
    await settle();
    expect(lastDashboard().variableConfigs).toEqual({ customer_id: { sql: 'SELECT id, id FROM customers' } });
  });

  it('REMOVES the configuration when blank SQL is saved', async () => {
    const { app, lastDashboard } = makeApp({
      currentWorkspace: workspace({
        dashboards: [dashboard({
          variableConfigs: { country: { sql: 'SELECT c, c' }, other: { sql: 'SELECT o, o' } },
        })],
      }),
    });
    openVariableEditor(app, 'd', 'country');
    input().value = '   \n  ';
    click('.varedit-save');
    await settle();
    // Whitespace-only is blank (normalizeVariableSql's rule) — the entry is gone,
    // never stored as an empty string, and every other entry survives.
    expect(lastDashboard().variableConfigs).toEqual({ other: { sql: 'SELECT o, o' } });
  });

  it('drops the variableConfigs object entirely once it would be empty', async () => {
    const { app, lastDashboard } = makeApp({
      currentWorkspace: workspace({
        dashboards: [dashboard({ variableConfigs: { country: { sql: 'SELECT c, c' } } })],
      }),
    });
    openVariableEditor(app, 'd', 'country');
    input().value = '';
    click('.varedit-save');
    await settle();
    expect(lastDashboard()).not.toHaveProperty('variableConfigs');
  });

  it('keeps an ORPHAN editable and saves it, preserving its remembered type', async () => {
    const { app, lastDashboard } = makeApp({
      currentWorkspace: workspace({
        queries: [query('q1', 'SELECT 1')],
        dashboards: [dashboard({
          variableConfigs: { region: { sql: 'SELECT r, r', lastKnownType: 'String' } },
        })],
      }),
    });
    openVariableEditor(app, 'd', 'region');
    // Editable — an orphan stays editable until it is deleted.
    expect(input().disabled).toBe(false);
    expect(input().readOnly).toBe(false);
    expect(input().value).toBe('SELECT r, r');
    expect(document.querySelector('.varedit-note')!.textContent).toContain('No panel declares this variable');
    input().value = 'SELECT r, r FROM regions';
    click('.varedit-save');
    await settle();
    expect(lastDashboard().variableConfigs)
      .toEqual({ region: { sql: 'SELECT r, r FROM regions', lastKnownType: 'String' } });
  });
});

describe('commitVariableConfig', () => {
  it('aborts, committing nothing, when there is no committed workspace', async () => {
    // `mutateWorkspace` hands the transform `null` when nothing is committed yet.
    let transformResult: unknown = 'never ran';
    const mutateWorkspace: App['mutateWorkspace'] = async (transform) => {
      transformResult = await transform(null);
      return { ok: false, aborted: true };
    };
    commitVariableConfig({ mutateWorkspace }, 'd', 'country', null);
    await settle();
    expect(transformResult).toBeNull();
  });

  it('aborts when the Dashboard id names no entry', async () => {
    const { app, committed } = makeApp();
    commitVariableConfig(app, 'gone', 'country', { sql: 'SELECT 1, 1' });
    await settle();
    expect(committed).toEqual([null]);
  });

  it('aborts on an AMBIGUOUS id rather than overwriting one of two matches', async () => {
    const { app, committed } = makeApp({
      currentWorkspace: workspace({ dashboards: [dashboard(), dashboard({ title: 'Copy' })] }),
    });
    commitVariableConfig(app, 'd', 'country', { sql: 'SELECT 1, 1' });
    await settle();
    expect(committed).toEqual([null]);
  });

  it('preserves every OTHER Dashboard, revisions included', async () => {
    const { app, committed } = makeApp({
      currentWorkspace: workspace({
        dashboards: [dashboard(), dashboard({ id: 'other', revision: 9 })],
      }),
    });
    commitVariableConfig(app, 'd', 'country', { sql: 'SELECT 1, 1' });
    await settle();
    expect(committed[0]!.dashboards[1]).toEqual(dashboard({ id: 'other', revision: 9 }));
    expect(committed[0]!.dashboards[0].revision).toBe(4);
  });
});

describe('the injected editor seam', () => {
  it('mounts the injected factory instead of the built-in textarea, and reads it on save', async () => {
    const destroy = vi.fn();
    const focus = vi.fn();
    const factory: VariableEditorFactory = vi.fn(() => ({
      getText: () => 'SELECT injected, injected',
      focus,
      destroy,
    }));
    const { app, lastDashboard } = makeApp({ VariableEditor: factory });
    openVariableEditor(app, 'd', 'country');
    expect(factory).toHaveBeenCalledWith({
      parent: document.querySelector('.varedit-sql'), document, text: '',
    });
    expect(focus).toHaveBeenCalled();
    // No built-in surface was created at all.
    expect(input()).toBeNull();
    click('.varedit-save');
    await settle();
    expect(lastDashboard().variableConfigs)
      .toEqual({ country: { sql: 'SELECT injected, injected', lastKnownType: 'String' } });
    // Closing after the save tore the injected surface down.
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('destroys the previous surface when the editor is re-targeted', () => {
    const destroy = vi.fn();
    const factory: VariableEditorFactory = vi.fn(() => ({ getText: () => '', focus: () => {}, destroy }));
    const { app } = makeApp({
      VariableEditor: factory,
      currentWorkspace: workspace({
        queries: [query('q1', 'SELECT 1 WHERE a = {country:String} AND b = {year:UInt16}')],
      }),
    });
    openVariableEditor(app, 'd', 'country');
    openVariableEditor(app, 'd', 'year');
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('createTextareaVariableEditor', () => {
  it('mounts a labelled, editable surface seeded with the stored text', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = createTextareaVariableEditor({ parent: host, document, text: 'SELECT 1, 1' });
    const field = host.querySelector('textarea')!;
    expect(field.value).toBe('SELECT 1, 1');
    expect(field.getAttribute('aria-label')).toBe('Option SQL');
    expect(handle.getText()).toBe('SELECT 1, 1');
    field.value = 'SELECT 2, 2';
    expect(handle.getText()).toBe('SELECT 2, 2');
    handle.focus();
    expect(document.activeElement).toBe(field);
    handle.destroy();
    expect(host.querySelector('textarea')).toBeNull();
  });
});
