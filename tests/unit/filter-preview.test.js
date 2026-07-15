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
  it('renders helper metadata and diagnostics with local-only controls', () => {
    const app = makeApp();
    app.activeTab().filterPreview = {
      status: 'success',
      normalized: {
        helpers: [{ name: 'origin', sourceType: 'Array(String)', totalOptions: 2, truncated: true,
          options: [{ value: 'ATL', label: 'Atlanta' }] }],
        diagnostics: [{ severity: 'warning', code: 'filter-options-truncated', message: 'limited' }],
      },
    };
    const out = renderFilterPreview(app);
    expect(out.textContent).toContain('origin');
    expect(out.textContent).toContain('Array(String)');
    expect(out.textContent).toContain('2 options');
    expect(out.textContent).toContain('Showing first 1 options');
    const input = out.querySelector('input');
    input.dispatchEvent(new Event('focus'));
    out.querySelector('[role="option"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(app.state.varValues).toEqual({});
    expect(app.state.filterActive).toEqual({});
    expect(app.saveVarValues).not.toHaveBeenCalled();
  });
  it('renders an empty successful result and the default error message', () => {
    const app = makeApp();
    app.activeTab().filterPreview = { status: 'success', normalized: { helpers: [], diagnostics: [] } };
    expect(renderFilterPreview(app).textContent).toBe('No options');
    app.activeTab().filterPreview = { status: 'error' };
    expect(renderFilterPreview(app).textContent).toBe('Filter options failed.');
  });
});
