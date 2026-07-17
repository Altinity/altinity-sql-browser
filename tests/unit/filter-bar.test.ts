import { describe, it, expect, vi } from 'vitest';
import { analyzeParameterizedSources, fieldControls } from '../../src/core/param-pipeline.js';
import type { FieldControl, PreparedFieldState } from '../../src/core/param-pipeline.js';
import { buildFilterBar, FILTER_DEBOUNCE_MS } from '../../src/ui/filter-bar.js';
import { makeApp } from '../helpers/fake-app.js';

// The field-family construction, debounce, commit, conflict, and optional
// behavior of buildFilterBar are exercised end-to-end through the dashboard
// suite (renderDashboard → buildFilterBar). These tests cover the extraction's
// own seams: the injected document realm, the accessible-group label (#185),
// and the dispose seam (#276 Phase 3b).
const paramsFor = (sql: string): FieldControl[] =>
  fieldControls(analyzeParameterizedSources([{ id: 't', kind: 'tab', sql, bindPolicy: 'row-returning' }]));
const okField = (): PreparedFieldState => ({ state: 'ok' });

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
    expect(bar.el.getAttribute('role')).toBe('group');
    expect(bar.el.getAttribute('aria-label')).toBe('Query filters');
    expect(bar.el.querySelectorAll('.var-field').length).toBe(1);
    expect(bar.el.style.display).not.toBe('none');
  });

  it('renders a hidden-but-labeled empty bar when there are no params', () => {
    const app = makeApp();
    const bar = buildFilterBar(app, [], () => {}, okField, { ariaLabel: 'Query filters' });
    expect(bar.el.style.display).toBe('none');
    expect(bar.el.getAttribute('aria-label')).toBe('Query filters');
    expect(bar.el.querySelectorAll('.var-field').length).toBe(0);
    expect(() => bar.dispose()).not.toThrow(); // no fields, no timers — a no-op
  });

  it('defaults to app.document and no group role when no options are passed', () => {
    const app = makeApp();
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField);
    expect(bar.el.getAttribute('role')).toBeNull();
    expect(bar.el.getAttribute('aria-label')).toBeNull();
    expect(bar.el.querySelectorAll('.var-field').length).toBe(1);
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
    document.body.appendChild(bar.el);
    bar.el.querySelector('input')!.dispatchEvent(new Event('focus'));
    bar.el.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(app.state.varValues.x).toBe('a');
    expect(app.state.filterActive.x).toBe(true);
    expect(app.saveVarValues).toHaveBeenCalled();
    expect(app.saveFilterActive).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith('x');
    bar.el.remove();
  });

  it('marks a curated field is-optional when its param is optional, same as a plain field', () => {
    const app = makeApp();
    const bar = buildFilterBar(
      app,
      paramsFor('SELECT {y:String} FROM t /*[ AND x = {x:String} ]*/'),
      () => {}, okField,
      { curatedFields: { y: { options: [{ value: 'a', label: 'Alpha' }] }, x: { options: [{ value: 'b', label: 'Beta' }] } } },
    );
    const fields = [...bar.el.querySelectorAll('.var-field')];
    expect(fields.map((f) => f.querySelector('.var-name')!.textContent)).toEqual(['y', 'x']);
    expect(fields.map((f) => f.classList.contains('is-optional'))).toEqual([false, true]);
    expect(fields.every((f) => f.classList.contains('is-curated'))).toBe(true);
  });

  it('marks a curated field is-conflict when its declared type disagrees across favorites (#173)', () => {
    const app = makeApp();
    const params = fieldControls(analyzeParameterizedSources([
      { id: 'A', kind: 'tab', sql: 'SELECT {x:UInt64}', bindPolicy: 'row-returning' },
      { id: 'B', kind: 'tab', sql: 'SELECT {x:String}', bindPolicy: 'row-returning' },
    ]));
    const bar = buildFilterBar(app, params, () => {}, okField, {
      curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }] } },
    });
    const input = bar.el.querySelector('input')!;
    expect(input.classList.contains('is-conflict')).toBe(true);
    expect(input.title).toContain('Conflicting type declarations: UInt64 vs String');
  });

  it('applies the shared is-invalid affordance to a curated field, same as a plain one', () => {
    const app = makeApp();
    const invalidField = (): PreparedFieldState => ({ state: 'invalid', reason: 'Bad value' });
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, invalidField, {
      curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }] } },
    });
    const input = bar.el.querySelector('input')!;
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect((input as HTMLInputElement).title).toBe('Bad value');
  });

  it('dispose() clears a pending debounce timer so a later value edit never fires the stale commit (#276)', () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      const onCommit = vi.fn();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), onCommit, okField);
      const input = bar.el.querySelector('input')! as HTMLInputElement;
      input.value = 'a';
      input.dispatchEvent(new Event('input', { bubbles: true })); // arms the debounce
      bar.dispose();
      vi.advanceTimersByTime(FILTER_DEBOUNCE_MS + 10);
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
