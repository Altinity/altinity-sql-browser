import { describe, it, expect, vi } from 'vitest';
import { analyzeParameterizedSources, fieldControls } from '../../src/core/param-pipeline.js';
import { buildFilterBar, FILTER_DEBOUNCE_MS } from '../../src/ui/filter-bar.js';
import { makeApp } from '../helpers/fake-app.js';

// The field-family construction, debounce, commit, conflict, and optional
// behavior of buildFilterBar are exercised end-to-end through the dashboard
// suite (renderDashboard → buildFilterBar). These tests cover the extraction's
// own seams: the injected document realm and the accessible-group label (#185).
const paramsFor = (sql) =>
  fieldControls(analyzeParameterizedSources([{ id: 't', kind: 'tab', sql, bindPolicy: 'row-returning' }]));
const okField = () => ({ state: 'ok' });

describe('buildFilterBar (shared filter row)', () => {
  it('is a labeled group and builds a field per param when ariaLabel + document are given', () => {
    const app = makeApp();
    const bar = buildFilterBar(
      app,
      paramsFor('SELECT * FROM t WHERE x = {x:String}'),
      () => {},
      okField,
      { document, ariaLabel: 'Query filters' },
    );
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toBe('Query filters');
    expect(bar.querySelectorAll('.var-field').length).toBe(1);
    expect(bar.style.display).not.toBe('none');
  });

  it('renders a hidden-but-labeled empty bar when there are no params', () => {
    const app = makeApp();
    const bar = buildFilterBar(app, [], () => {}, okField, { ariaLabel: 'Query filters' });
    expect(bar.style.display).toBe('none');
    expect(bar.getAttribute('aria-label')).toBe('Query filters');
    expect(bar.querySelectorAll('.var-field').length).toBe(0);
  });

  it('defaults to app.document and no group role when no options are passed', () => {
    const app = makeApp();
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField);
    expect(bar.getAttribute('role')).toBeNull();
    expect(bar.getAttribute('aria-label')).toBeNull();
    expect(bar.querySelectorAll('.var-field').length).toBe(1);
  });

  it('exposes the shared debounce constant', () => {
    expect(FILTER_DEBOUNCE_MS).toBe(500);
  });

  it('persists and commits curated selections', () => {
    const app = makeApp();
    const onCommit = vi.fn();
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), onCommit, okField, {
      curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }] } },
    });
    document.body.appendChild(bar);
    bar.querySelector('input').dispatchEvent(new Event('focus'));
    bar.querySelector('[role="option"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(app.state.varValues.x).toBe('a');
    expect(app.state.filterActive.x).toBe(true);
    expect(app.saveVarValues).toHaveBeenCalled();
    expect(app.saveFilterActive).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith('x');
    bar.remove();
  });

  it('marks a curated field is-optional when its param is optional, same as a plain field', () => {
    const app = makeApp();
    const bar = buildFilterBar(
      app,
      paramsFor('SELECT {y:String} FROM t /*[ AND x = {x:String} ]*/'),
      () => {}, okField,
      { curatedFields: { y: { options: [{ value: 'a', label: 'Alpha' }] }, x: { options: [{ value: 'b', label: 'Beta' }] } } },
    );
    const fields = [...bar.querySelectorAll('.var-field')];
    expect(fields.map((f) => f.querySelector('.var-name').textContent)).toEqual(['y', 'x']);
    expect(fields.map((f) => f.classList.contains('is-optional'))).toEqual([false, true]);
    expect(fields.every((f) => f.classList.contains('is-curated'))).toBe(true);
  });

  it('applies the shared is-invalid affordance to a curated field, same as a plain one', () => {
    const app = makeApp();
    const invalidField = () => ({ state: 'invalid', reason: 'Bad value' });
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, invalidField, {
      curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }] } },
    });
    const input = bar.querySelector('input');
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(input.title).toBe('Bad value');
  });
});
