import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountWorkbenchShell } from '../../src/ui/workbench/workbench-shell.js';
import { startDrag } from '../../src/ui/splitters.js';
import { makeApp } from '../helpers/fake-app.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('mountWorkbenchShell', () => {
  it('keeps authored tabs mounted when Spec revalidation fails persistently', () => {
    const revalidateSpecDrafts = vi.fn(() => {
      throw new Error('raw validator implementation detail');
    });
    const app = makeApp({ queryDoc: { revalidateSpecDrafts } });
    const tab = app.state.tabs.value[0];
    tab.name = 'Recovered draft';
    tab.sqlDraft = 'SELECT authored';
    tab.dirtySql = true;
    const sqlSync = vi.spyOn(app.sqlEditor, 'syncFromState');
    const specSync = vi.spyOn(app.specEditor, 'syncFromState');
    const queryHost = document.createElement('div');
    document.body.appendChild(queryHost);

    const dispose = mountWorkbenchShell({
      app,
      document,
      state: app.state,
      actions: app.actions,
      sqlEditor: app.sqlEditor,
      specEditor: app.specEditor,
      workbench: app.workbench,
      queryDoc: app.queryDoc,
      prefs: app.prefs,
      queryHost,
      activeTab: app.activeTab,
      updateSaveBtn: app.updateSaveBtn,
      specBlocked: app.specBlocked,
      renderVarStrip: app.renderVarStrip,
      setRunBtn: app.setRunBtn,
      setExportBtn: app.setExportBtn,
      startDrag,
    });

    expect(revalidateSpecDrafts).toHaveBeenCalledOnce();
    expect(sqlSync).toHaveBeenCalledOnce();
    expect(specSync).toHaveBeenCalledOnce();
    expect(queryHost.querySelector('.workbench')).not.toBeNull();
    expect(queryHost.querySelector('.qtabs-inner')?.textContent).toContain('Recovered draft');
    expect(app.activeTab()).toMatchObject({
      name: 'Recovered draft',
      sqlDraft: 'SELECT authored',
      dirtySql: true,
    });
    expect(queryHost.textContent).not.toContain('raw validator implementation detail');

    // A later tab-signal repaint remains usable under the same persistent
    // outage and performs the normal editor synchronization exactly once.
    app.state.tabs.value = [...app.state.tabs.value];
    expect(revalidateSpecDrafts).toHaveBeenCalledTimes(2);
    expect(sqlSync).toHaveBeenCalledTimes(2);
    expect(specSync).toHaveBeenCalledTimes(2);
    expect(queryHost.querySelector('.workbench')).not.toBeNull();

    dispose();
  });
});
