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

// #447 phase 2: a successful configuration write asks any rendered Dashboard to
// re-read committed truth. A viewer session reads `variableConfigs` ONCE, at
// construction, so without this the stored document changed while the on-screen
// controls kept running the previous configuration until the Dashboard happened to
// be reopened.
describe('commitVariableConfig — refreshing a rendered Dashboard (#447 phase 2)', () => {
  it('asks the Dashboard to re-read committed truth after a successful commit', async () => {
    const onWorkspaceExternallyChanged = vi.fn();
    const { app } = makeApp({ onWorkspaceExternallyChanged });
    commitVariableConfig(app, 'd', 'country', { sql: 'SELECT a, b FROM t' });
    await settle();
    expect(onWorkspaceExternallyChanged).toHaveBeenCalledOnce();
  });

  it('does NOT ask after an aborted commit — nothing changed to re-read', async () => {
    const onWorkspaceExternallyChanged = vi.fn();
    // A Dashboard id that resolves to nothing aborts the transform.
    const { app } = makeApp({ onWorkspaceExternallyChanged });
    commitVariableConfig(app, 'no-such-dashboard', 'country', { sql: 'SELECT a, b FROM t' });
    await settle();
    expect(onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('works when no Dashboard is rendered (no hook injected)', async () => {
    const { app, committed } = makeApp();
    commitVariableConfig(app, 'd', 'country', null);
    await settle();
    expect(committed).toHaveLength(1);
  });

  it('refreshes after the tree deletes an orphan configuration too', async () => {
    const onWorkspaceExternallyChanged = vi.fn();
    const { app } = makeApp({ onWorkspaceExternallyChanged });
    commitVariableConfig(app, 'd', 'country', null);
    await settle();
    expect(onWorkspaceExternallyChanged).toHaveBeenCalledOnce();
  });
});

// #447 phase 2: the Test action. It validates the DRAFT locally first (so nothing
// is sent for a problem the app can already see), then runs this variable's query
// alone and checks its result shape — the only place the "exactly two String
// columns" rule is checkable, since a combined batch reports one merged column
// list for every branch.
describe('openVariableEditor — Test (#447 phase 2)', () => {
  const testBtn = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('.varedit-test')!;
  const result = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.varedit-result');
  const twoStringColumns = [{ name: 'v', type: 'String' }, { name: 'l', type: 'String' }];

  /** Open the editor on `country` with an injected runner. */
  function openWith(
    runOptionQuery: VariableEditorApp['runOptionQuery'],
    sql = 'SELECT a, b FROM countries',
  ) {
    const dash = dashboard({ variableConfigs: { country: { sql } } });
    const { app } = makeApp({ currentWorkspace: workspace({ dashboards: [dash] }), runOptionQuery });
    openVariableEditor(app, 'd', 'country');
    return app;
  }

  it('offers no Test button when no runner is injected', () => {
    const { app } = makeApp();
    openVariableEditor(app, 'd', 'country');
    expect(panel()).not.toBeNull();
    expect(document.querySelector('.varedit-test')).toBeNull();
  });

  it('runs the draft nested exactly as a batch branch embeds it, and bounded', () => {
    const runOptionQuery = vi.fn(async (_sql: string) => ({ columns: twoStringColumns, rows: [] as unknown[][], error: null }));
    openWith(runOptionQuery, 'SELECT a, b FROM countries');
    testBtn().click();
    expect(runOptionQuery).toHaveBeenCalledWith(
      'SELECT * FROM (\nSELECT a, b FROM countries\n) LIMIT 1001',
    );
  });

  it('tests the CURRENT editor text, not the stored SQL', () => {
    const runOptionQuery = vi.fn(async (_sql: string) => ({ columns: twoStringColumns, rows: [] as unknown[][], error: null }));
    openWith(runOptionQuery, 'SELECT old, old FROM t');
    input().value = 'SELECT fresh, fresh FROM t';
    testBtn().click();
    expect(runOptionQuery.mock.calls[0][0]).toContain('SELECT fresh, fresh FROM t');
  });

  it('reports a local rejection WITHOUT sending anything, listing every finding', async () => {
    const runOptionQuery = vi.fn(async () => ({ columns: twoStringColumns, rows: [], error: null }));
    openWith(runOptionQuery);
    input().value = 'SHOW TABLES FORMAT JSON';
    testBtn().click();
    await settle();
    expect(runOptionQuery).not.toHaveBeenCalled();
    expect(result()!.className).toContain('is-error');
    expect(result()!.textContent).toContain('must be a SELECT');
    expect(result()!.textContent).toContain('FORMAT');
  });

  it('reports the no-cascading rejection without sending anything', async () => {
    const runOptionQuery = vi.fn(async () => ({ columns: twoStringColumns, rows: [], error: null }));
    openWith(runOptionQuery);
    input().value = 'SELECT a, b FROM t WHERE x = {other:String}';
    testBtn().click();
    await settle();
    expect(runOptionQuery).not.toHaveBeenCalled();
    expect(result()!.textContent).toBe('Variable option queries cannot reference Dashboard variables yet.');
  });

  it('accepts two String columns and previews the options', async () => {
    openWith(async () => ({
      columns: twoStringColumns,
      rows: [['de', 'Germany'], ['fr', 'France']],
      error: null,
    }));
    testBtn().click();
    await settle();
    expect(result()!.className).toContain('is-ok');
    expect(result()!.textContent).toContain('Valid — 2 options.');
    expect(result()!.textContent).toContain('Germany');
  });

  it('says "1 option" for a single row', async () => {
    openWith(async () => ({ columns: twoStringColumns, rows: [['de', 'Germany']], error: null }));
    testBtn().click();
    await settle();
    expect(result()!.textContent).toContain('Valid — 1 option.');
  });

  it('treats zero rows as a pass with a caveat, not a failure', async () => {
    openWith(async () => ({ columns: twoStringColumns, rows: [], error: null }));
    testBtn().click();
    await settle();
    expect(result()!.className).toContain('is-ok');
    expect(result()!.textContent).toContain('returned no options');
  });

  it('caps the preview and says how many more there are', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => [`v${i}`, `L${i}`]);
    openWith(async () => ({ columns: twoStringColumns, rows, error: null }));
    testBtn().click();
    await settle();
    expect(document.querySelectorAll('.varedit-result-row')).toHaveLength(5);
    expect(result()!.textContent).toContain('+4 more');
  });

  it('rejects the wrong column count from the server response', async () => {
    openWith(async () => ({
      columns: [{ name: 'only', type: 'String' }], rows: [['x']], error: null,
    }));
    testBtn().click();
    await settle();
    expect(result()!.className).toContain('is-error');
    expect(result()!.textContent).toContain('exactly two columns');
  });

  it('rejects a non-String column, naming the type', async () => {
    openWith(async () => ({
      columns: [{ name: 'v', type: 'UInt64' }, { name: 'l', type: 'String' }],
      rows: [['1', 'one']],
      error: null,
    }));
    testBtn().click();
    await settle();
    expect(result()!.textContent).toContain('UInt64');
  });

  it('reports a server error verbatim', async () => {
    openWith(async () => ({ columns: [], rows: [], error: 'Code: 60. Unknown table' }));
    testBtn().click();
    await settle();
    expect(result()!.className).toContain('is-error');
    expect(result()!.textContent).toBe('Code: 60. Unknown table');
  });

  it('disables the button and shows progress while in flight, re-enabling after', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    openWith(async () => {
      await gate;
      return { columns: twoStringColumns, rows: [], error: null };
    });
    testBtn().click();
    expect(testBtn().disabled).toBe(true);
    expect(result()!.textContent).toContain('Running');
    release!();
    await settle();
    expect(testBtn().disabled).toBe(false);
  });

  it('is a polite live region, so the verdict is announced', () => {
    openWith(async () => ({ columns: twoStringColumns, rows: [], error: null }));
    expect(result()!.getAttribute('aria-live')).toBe('polite');
    // Hidden until there is something to say.
    expect(result()!.style.display).toBe('none');
  });

  it('drops a response that arrives after the panel was closed', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = openWith(async () => {
      await gate;
      return { columns: twoStringColumns, rows: [['de', 'Germany']], error: null };
    });
    testBtn().click();
    closeVariableEditor(app);
    release!();
    await settle();
    // No panel to paint into, and nothing thrown.
    expect(document.querySelector('.varedit-panel')).toBeNull();
  });

  it('cannot start a second Test while one is in flight', async () => {
    // The disabled button is the whole concurrency control — which is why no
    // generation counter is needed on top of the panel-identity guard.
    let calls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    openWith(async () => {
      calls++;
      await gate;
      return { columns: twoStringColumns, rows: [['de', 'Germany']], error: null };
    });
    testBtn().click();
    testBtn().click();
    testBtn().click();
    expect(calls).toBe(1);
    release!();
    await settle();
    expect(result()!.textContent).toContain('Germany');
    // Re-enabled, so a second Test is possible once the first has answered.
    testBtn().click();
    expect(calls).toBe(2);
  });

  it('drops a response whose panel was re-targeted to another variable', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dash = dashboard({
      variableConfigs: { country: { sql: 'SELECT a, b FROM c' }, city: { sql: 'SELECT a, b FROM d' } },
    });
    const { app } = makeApp({
      currentWorkspace: workspace({
        queries: [query('q1', 'SELECT {country:String} AS c, {city:String} AS t')],
        dashboards: [dash],
      }),
      runOptionQuery: async () => {
        await gate;
        return { columns: twoStringColumns, rows: [['de', 'Germany']], error: null };
      },
    });
    openVariableEditor(app, 'd', 'country');
    testBtn().click();
    openVariableEditor(app, 'd', 'city');   // re-target tears the old panel down
    release!();
    await settle();
    expect(document.querySelector('.varedit-title-name')!.textContent).toBe('city');
    expect(result()!.style.display).toBe('none');
  });

  it('still offers Test for an ORPHANED configuration', () => {
    // An orphan stays fully editable until it is deleted, so it stays testable.
    const dash = dashboard({
      tiles: [],
      variableConfigs: { gone: { sql: 'SELECT a, b FROM t', lastKnownType: 'String' } },
    });
    const runOptionQuery = vi.fn(async () => ({ columns: twoStringColumns, rows: [], error: null }));
    const { app } = makeApp({
      currentWorkspace: workspace({ dashboards: [dash] }), runOptionQuery,
    });
    openVariableEditor(app, 'd', 'gone');
    testBtn().click();
    expect(runOptionQuery).toHaveBeenCalled();
  });
});
