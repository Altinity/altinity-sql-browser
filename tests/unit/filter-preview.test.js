import { describe, expect, it } from 'vitest';
import { renderFilterPreview } from '../../src/ui/filter-preview.js';
import { makeApp } from '../helpers/fake-app.js';

describe('Filter preview', () => {
  it('renders no-result, running, and error states', () => {
    const app = makeApp();
    expect(renderFilterPreview(app).textContent).toContain('Run the query');
    app.activeTab().filterPreview = { status: 'running' };
    expect(renderFilterPreview(app).textContent).toContain('when the query completes');
    app.activeTab().filterPreview = { status: 'error', error: 'boom' };
    expect(renderFilterPreview(app).textContent).toBe('boom');
  });
  it('renders helpers as a result-grid with a name/options/type/example header and a local-only combobox', () => {
    const app = makeApp();
    app.activeTab().filterPreview = {
      status: 'success',
      normalized: {
        helpers: [
          { name: 'user', sourceType: 'Array(String)', totalOptions: 2, truncated: false,
            options: [{ value: 'ATL', label: 'Atlanta' }, { value: 'JFK', label: 'New York' }] },
          { name: 'query_kind', sourceType: 'Array(String)', totalOptions: 1, truncated: false,
            options: [{ value: 'Select', label: 'Select' }] },
        ],
        diagnostics: [{ severity: 'warning', code: 'filter-options-truncated', message: 'limited' }],
      },
    };
    const out = renderFilterPreview(app);
    // Same grid presentation as the Table view.
    const table = out.querySelector('table.res-table');
    expect(table).toBeTruthy();
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent))
      .toEqual(['#', 'name', 'options', 'type', 'example']);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    // Row 1: number, name, option count, type, and the interactive combobox.
    const cells = rows[0].querySelectorAll('td');
    expect(cells[0].textContent).toBe('1');
    expect(cells[1].textContent).toBe('user');
    expect(cells[2].textContent).toBe('2');
    expect(cells[3].textContent).toBe('Array(String)');
    const combo = cells[4].querySelector('.var-combo.filter-select .var-input');
    expect(combo).toBeTruthy();
    // No clear × in the preview (demo cell, not a live filter).
    expect(cells[4].querySelector('.var-combo-clear-inline')).toBeNull();
    // The combobox is local-only: committing an option never touches shared state.
    combo.dispatchEvent(new Event('focus'));
    cells[4].querySelector('[role="option"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(app.state.varValues).toEqual({});
    expect(app.state.filterActive).toEqual({});
    expect(app.saveVarValues).not.toHaveBeenCalled();
    // Diagnostics render below the grid.
    expect(out.querySelector('.filter-preview-diagnostic.is-warning').textContent).toBe('limited');
  });
  it('renders an empty successful result and the default error message', () => {
    const app = makeApp();
    app.activeTab().filterPreview = { status: 'success', normalized: { helpers: [], diagnostics: [] } };
    expect(renderFilterPreview(app).textContent).toBe('No options');
    app.activeTab().filterPreview = { status: 'error' };
    expect(renderFilterPreview(app).textContent).toBe('Filter options failed.');
  });
});
