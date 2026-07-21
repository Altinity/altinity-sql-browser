import { describe, it, expect, vi } from 'vitest';
import { analyzeParameterizedSources, fieldControls } from '../../src/core/param-pipeline.js';
import type { FieldControl, PreparedFieldState } from '../../src/core/param-pipeline.js';
import { buildFilterBar, FILTER_DEBOUNCE_MS } from '../../src/ui/filter-bar.js';
import { emptyRecentMap, recordRecent } from '../../src/core/recent-values.js';
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

  it('a recent-value pick commits immediately and Clear recent clears the field recents (#171)', () => {
    const app = makeApp();
    app.state.varRecent = recordRecent(emptyRecentMap(), 'x', 'foo');
    const onCommit = vi.fn();
    const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), onCommit, okField, { document });
    document.body.appendChild(bar.el);
    const input = bar.el.querySelector('input')!;
    input.dispatchEvent(new Event('focus'));
    const opt = bar.el.querySelector('[role="option"]');
    expect(opt).not.toBeNull();
    opt!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(onCommit).toHaveBeenCalledWith('x'); // onPick — immediate commit
    input.dispatchEvent(new Event('focus'));
    bar.el.querySelector('.var-combo-footer button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(app.params.clearVarRecent).toHaveBeenCalledWith('x'); // onClearRecent
    bar.el.remove();
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
    expect(app.params.saveVarValues).toHaveBeenCalled();
    expect(app.params.saveFilterActive).toHaveBeenCalled();
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

  // #345: compact, type-aware field widths — one stable ch width per field,
  // resolved from the declared type (or 'enum' for a dropdown/curated field).
  describe('field width (#345)', () => {
    it('a plain text field (String) gets the generic string width', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {name:String}'), () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('16');
    });
    it('a tiny-integer field (UInt8) gets the bool/tiny-int width', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {flag:UInt8}'), () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('9');
    });
    it('a Date field is narrower than a DateTime field, even though both render the date-like combobox', () => {
      const app = makeApp();
      const dateBar = buildFilterBar(app, paramsFor('SELECT {d:Date}'), () => {}, okField);
      const dtBar = buildFilterBar(app, paramsFor('SELECT {dt:DateTime}'), () => {}, okField);
      expect(dateBar.el.querySelector<HTMLInputElement>('.var-input')!.style.getPropertyValue('--var-input-ch')).toBe('13');
      expect(dtBar.el.querySelector<HTMLInputElement>('.var-input')!.style.getPropertyValue('--var-input-ch')).toBe('17');
    });
    it("a declared Enum8 field gets the enum width", () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor("SELECT {kind:Enum8('a' = 1, 'b' = 2)}"), () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('14');
    });
    it('a curated field gets the enum width regardless of its declared type', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:UInt64}'), () => {}, okField, {
        curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }] } },
      });
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('14');
    });
    it('a type-conflicted field still gets a width, from its first bound declaration\'s type', () => {
      const app = makeApp();
      const params = fieldControls(analyzeParameterizedSources([
        { id: 'A', kind: 'tab', sql: 'SELECT {x:UInt64}', bindPolicy: 'row-returning' },
        { id: 'B', kind: 'tab', sql: 'SELECT {x:String}', bindPolicy: 'row-returning' },
      ]));
      const bar = buildFilterBar(app, params, () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      expect(input.style.getPropertyValue('--var-input-ch')).toBe('13'); // UInt64 (first declaration) → numeric
    });
    it('never changes while typing — set once at field build, not on every keystroke', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {name:String}'), () => {}, okField);
      const input = bar.el.querySelector<HTMLInputElement>('.var-input')!;
      const before = input.style.getPropertyValue('--var-input-ch');
      input.value = 'a much longer value than the field is wide';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(input.style.getPropertyValue('--var-input-ch')).toBe(before);
    });
  });

  // #360: a source-backed curated field now stays in this rich-combobox
  // rendering path for EVERY non-idle status — not just when it currently
  // has options — and shows a structural (class + disabled/aria-disabled +,
  // for 'waiting', literal text) affordance instead of silently rendering
  // (or falling out to) an unmarked control (plan-review BLOCKER-2).
  describe('curated field status affordance (#360)', () => {
    it('an explicit status: "ready" (or an absent status) renders the normal curated combobox — no new classes, not disabled', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }], status: 'ready' } },
      });
      const label = bar.el.querySelector('.var-field')!;
      const input = bar.el.querySelector('input') as HTMLInputElement;
      expect(label.classList.contains('is-curated')).toBe(true);
      expect(label.classList.contains('is-waiting')).toBe(false);
      expect(label.classList.contains('is-error')).toBe(false);
      expect(label.classList.contains('is-stale')).toBe(false);
      expect(input.disabled).toBe(false);
      expect(input.hasAttribute('aria-disabled')).toBe(false);
    });

    it('status: "waiting" disables the field, adds is-waiting, and names the missing params as literal text', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [], status: 'waiting', waitingFor: ['from', 'to'] } },
      });
      const label = bar.el.querySelector('.var-field')!;
      const input = bar.el.querySelector('input') as HTMLInputElement;
      expect(label.classList.contains('is-curated')).toBe(true);
      expect(label.classList.contains('is-waiting')).toBe(true);
      expect(input.disabled).toBe(true);
      expect(input.getAttribute('aria-disabled')).toBe('true');
      expect(input.placeholder).toBe('Waiting for: from, to');
      expect(label.textContent).toContain('Waiting for: from, to');
    });

    it('status: "waiting" with no waitingFor still renders (empty missing-list text, no throw)', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [], status: 'waiting' } },
      });
      const input = bar.el.querySelector('input') as HTMLInputElement;
      expect(input.placeholder).toBe('Waiting for: ');
    });

    it.each(['source-error', 'helper-error', 'missing-helper'])(
      'status: "%s" disables the field and adds is-error, without the waiting note', (status) => {
        const app = makeApp();
        const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
          curatedFields: { x: { options: [], status } },
        });
        const label = bar.el.querySelector('.var-field')!;
        const input = bar.el.querySelector('input') as HTMLInputElement;
        expect(label.classList.contains('is-error')).toBe(true);
        expect(label.classList.contains('is-waiting')).toBe(false);
        expect(input.disabled).toBe(true);
        expect(input.getAttribute('aria-disabled')).toBe('true');
        expect(label.querySelector('.var-field-note')).toBeNull();
      },
    );

    it('status: "loading" marks the field is-stale + disabled while keeping its last-known options, not clearing them', () => {
      const app = makeApp();
      app.state.varValues.x = 'a';
      app.state.filterActive.x = true;
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }], status: 'loading' } },
      });
      const label = bar.el.querySelector('.var-field')!;
      const input = bar.el.querySelector('input') as HTMLInputElement;
      expect(label.classList.contains('is-stale')).toBe(true);
      expect(input.disabled).toBe(true);
      expect(input.getAttribute('aria-disabled')).toBe('true');
      // The last-known selection is still shown (not blanked as "no longer
      // current") — only marked stale, per the #360 acceptance criterion.
      expect(input.value).toBe('Alpha');
    });

    it('stale: true (independent of status) also marks the field is-stale, e.g. a ready-but-just-superseded read', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }], status: 'ready', stale: true } },
      });
      const label = bar.el.querySelector('.var-field')!;
      expect(label.classList.contains('is-stale')).toBe(true);
      expect((bar.el.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    });
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
