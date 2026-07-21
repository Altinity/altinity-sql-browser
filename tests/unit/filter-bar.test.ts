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
    expect(() => bar.updateStatus({})).not.toThrow(); // no curated fields — a no-op
    expect(bar.openMultiSelectParam()).toBeNull(); // no multiselect fields at all — always null
    expect(() => bar.focusMultiSelectTrigger('x')).not.toThrow(); // unknown param — a no-op
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
  // rendering path for EVERY status (including 'idle', its FIRST-ever value
  // before the shared source has run at all — dashboard.ts's rebuildFilterBar
  // now gates curation on `sourceId != null`, topology, never on `status`) and
  // shows a structural (class + disabled/aria-disabled +, for 'waiting',
  // literal text) affordance instead of silently rendering (or falling out
  // to) an unmarked control (plan-review BLOCKER-2).
  describe('curated field status affordance (#360)', () => {
    it('status: "idle" (a source-backed field that has never run yet) still renders CURATED, marked pending — not an enabled plain control', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [], status: 'idle' } },
      });
      const label = bar.el.querySelector('.var-field')!;
      const input = bar.el.querySelector('input') as HTMLInputElement;
      expect(label.classList.contains('is-curated')).toBe(true);
      // 'idle' reads exactly like 'loading' — pending, not yet actionable.
      expect(label.classList.contains('is-stale')).toBe(true);
      expect(input.disabled).toBe(true);
      expect(input.getAttribute('aria-disabled')).toBe('true');
    });

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

    // #189 review (F4, coordinator ruling — REVERTED): this is the STRICT
    // single-select curated combobox (#160 — blur/Enter reverts non-option
    // text), so leaving it enabled while erroring was a dishonest affordance
    // (looks editable, silently discards everything typed). Disabled again on
    // every error status, same as before #189.
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

  // #360 follow-up: `updateStatus` updates a curated field's affordance IN
  // PLACE — the whole point being that the caller (dashboard.ts) never has to
  // rebuild the bar (and disturb every other field's in-progress typing) just
  // because ONE source-backed filter's status changed.
  describe('updateStatus (#360 follow-up)', () => {
    it('flips a curated field idle → loading → ready → waiting → error without ever rebuilding it (same input instance throughout)', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [], status: 'idle' } },
      });
      const label = bar.el.querySelector('.var-field')!;
      const input = bar.el.querySelector('input') as HTMLInputElement;

      bar.updateStatus({ x: { status: 'loading' } });
      expect(bar.el.querySelector('input')).toBe(input); // same instance — no rebuild
      expect(label.classList.contains('is-stale')).toBe(true);
      expect(input.disabled).toBe(true);

      bar.updateStatus({ x: { status: 'ready' } });
      expect(bar.el.querySelector('input')).toBe(input);
      expect(label.classList.contains('is-stale')).toBe(false);
      expect(input.disabled).toBe(false);
      expect(input.hasAttribute('aria-disabled')).toBe(false);

      bar.updateStatus({ x: { status: 'waiting', waitingFor: ['from'] } });
      expect(bar.el.querySelector('input')).toBe(input);
      expect(label.classList.contains('is-waiting')).toBe(true);
      expect(label.classList.contains('is-stale')).toBe(false);
      expect(input.disabled).toBe(true);
      expect(label.textContent).toContain('Waiting for: from');
      const noteEl = label.querySelector('.var-field-note');

      // A SECOND consecutive 'waiting' update (still missing a different root
      // param) reuses the SAME note element — updates its text in place
      // rather than removing and recreating it.
      bar.updateStatus({ x: { status: 'waiting', waitingFor: ['to'] } });
      expect(label.querySelector('.var-field-note')).toBe(noteEl);
      expect(label.textContent).toContain('Waiting for: to');

      bar.updateStatus({ x: { status: 'source-error' } });
      expect(bar.el.querySelector('input')).toBe(input);
      expect(label.classList.contains('is-error')).toBe(true);
      expect(label.classList.contains('is-waiting')).toBe(false);
      // #189 F4 revert: error disables the field again (see the it.each above).
      expect(input.disabled).toBe(true);
      // The waiting note is removed once the field leaves 'waiting'.
      expect(label.querySelector('.var-field-note')).toBeNull();
    });

    it('preserves an in-progress typed draft across an updateStatus call (no rebuild disturbs it)', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }], status: 'ready' } },
      });
      const input = bar.el.querySelector('input') as HTMLInputElement;
      input.value = 'still typing…';
      bar.updateStatus({ x: { status: 'loading' } });
      expect(input.value).toBe('still typing…'); // untouched by the status update
      expect(bar.el.querySelector('input')).toBe(input);
    });

    it('ignores a status for a param this bar never curated (a plain field), and a plain field is never disabled by it', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField);
      const input = bar.el.querySelector('input') as HTMLInputElement;
      expect(() => bar.updateStatus({ x: { status: 'waiting' } })).not.toThrow();
      expect(input.disabled).toBe(false);
      expect(input.classList.contains('is-waiting')).toBe(false);
    });

    it('an updateStatus() call that names no curated field is a no-op (leaves its current affordance untouched)', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }], status: 'ready' } },
      });
      const input = bar.el.querySelector('input') as HTMLInputElement;
      expect(() => bar.updateStatus({})).not.toThrow();
      expect(input.disabled).toBe(false); // still ready — never touched
    });
  });

  // #189: the curated MULTISELECT field (selection.mode: 'multiple') and the
  // single-select-on-Array wrap (selection.mode: 'single', array: true) —
  // both new curated shapes wired through `onApplyCurated`.
  describe('multiselect / array-wrapped curated fields (#189)', () => {
    it('renders buildMultiSelectField (not the combobox) for selection.mode "multiple", and Apply routes through onApplyCurated', () => {
      const app = makeApp();
      const onApplyCurated = vi.fn();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: {
          x: {
            options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }],
            selection: { mode: 'multiple', array: true }, value: ['a'], active: true,
          },
        },
        onApplyCurated,
      });
      document.body.appendChild(bar.el);
      expect(bar.el.querySelector('.ms-field')).not.toBeNull();
      expect(bar.el.querySelector('.var-combo')).toBeNull(); // not the scalar combobox path
      bar.el.querySelector('.ms-trigger')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const cbs = [...document.body.querySelectorAll('.ms-option input[type="checkbox"]')] as HTMLInputElement[];
      cbs[1].checked = true;
      cbs[1].dispatchEvent(new Event('change', { bubbles: true }));
      document.body.querySelector('.ms-btn-primary')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onApplyCurated).toHaveBeenCalledWith('x', ['a', 'b'], true);
      bar.el.remove();
    });

    it('does NOT render a multiselect field for a scalar (absent or single, non-array) selection contract', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [{ value: 'a', label: 'Alpha' }] } },
      });
      expect(bar.el.querySelector('.ms-field')).toBeNull();
      expect(bar.el.querySelector('.var-combo')).not.toBeNull();
    });

    it('a multiselect field in an error status falls back to the SAME plain-commit seam a non-curated field uses', () => {
      const app = makeApp();
      const onCommit = vi.fn();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), onCommit, okField, {
        curatedFields: {
          x: {
            options: [], selection: { mode: 'multiple', array: true }, value: ['a'], active: true,
            status: 'source-error',
          },
        },
      });
      document.body.appendChild(bar.el);
      const errInput = bar.el.querySelector('input.is-error') as HTMLInputElement;
      expect(errInput).not.toBeNull();
      errInput.value = 'raw text';
      errInput.dispatchEvent(new Event('input', { bubbles: true }));
      errInput.dispatchEvent(new Event('blur', { bubbles: true }));
      expect(app.state.varValues.x).toBe('raw text');
      expect(app.state.filterActive.x).toBe(true);
      expect(app.params.saveVarValues).toHaveBeenCalled();
      expect(app.params.saveFilterActive).toHaveBeenCalled();
      expect(onCommit).toHaveBeenCalledWith('x');
      bar.el.remove();
    });

    it('updateStatus patches a multiselect field in place (same trigger instance, no rebuild)', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: {
          x: {
            options: [{ value: 'a', label: 'Alpha' }], selection: { mode: 'multiple', array: true },
            value: [], active: false, status: 'ready',
          },
        },
      });
      const trigger = bar.el.querySelector('.ms-trigger') as HTMLButtonElement;
      bar.updateStatus({ x: { status: 'loading' } });
      expect(bar.el.querySelector('.ms-trigger')).toBe(trigger);
      expect(trigger.disabled).toBe(true);
    });

    it('openMultiSelectParam() reflects an open popover\'s parameter, and dispose() cancels it with no onApplyCurated call', () => {
      const app = makeApp();
      const onApplyCurated = vi.fn();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: {
          x: {
            options: [{ value: 'a', label: 'Alpha' }], selection: { mode: 'multiple', array: true },
            value: [], active: false,
          },
        },
        onApplyCurated,
      });
      document.body.appendChild(bar.el);
      expect(bar.openMultiSelectParam()).toBeNull();
      bar.el.querySelector('.ms-trigger')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(bar.openMultiSelectParam()).toBe('x');
      expect(document.body.querySelector('.ms-popover')).not.toBeNull();
      bar.dispose();
      expect(document.body.querySelector('.ms-popover')).toBeNull();
      expect(onApplyCurated).not.toHaveBeenCalled();
      bar.el.remove();
    });

    it('focusMultiSelectTrigger(name) focuses that parameter\'s trigger (#189 F2b)', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: {
          x: {
            options: [{ value: 'a', label: 'Alpha' }], selection: { mode: 'multiple', array: true },
            value: [], active: false,
          },
        },
      });
      document.body.appendChild(bar.el);
      const trigger = bar.el.querySelector('.ms-trigger') as HTMLButtonElement;
      bar.focusMultiSelectTrigger('x');
      expect(document.activeElement).toBe(trigger);
      bar.el.remove();
    });

    it('an absent (undefined) committed value falls back to an empty array, not the raw string passthrough', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: { x: { options: [], selection: { mode: 'multiple', array: true } } },
      });
      const trigger = bar.el.querySelector('.ms-trigger') as HTMLButtonElement;
      expect(trigger.textContent).toBe('Not set'); // required (not optional) + empty/inactive
    });

    it('a raw-string committed value (#189 F1 error-mode fallback) passes through instead of dropping to an empty array', () => {
      const app = makeApp();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: {
          x: {
            options: [], selection: { mode: 'multiple', array: true }, value: 'typed raw', active: true,
            status: 'ready',
          },
        },
      });
      const trigger = bar.el.querySelector('.ms-trigger') as HTMLButtonElement;
      expect(trigger.textContent).toBe('typed raw');
    });

    it('marks the multiselect field is-optional when its param is optional, same as the scalar curated field (T2)', () => {
      const app = makeApp();
      const bar = buildFilterBar(
        app,
        paramsFor('SELECT {y:String} FROM t /*[ AND x = {x:String} ]*/'),
        () => {}, okField,
        {
          curatedFields: {
            y: { options: [{ value: 'a', label: 'Alpha' }], selection: { mode: 'multiple', array: true }, value: [] },
            x: { options: [{ value: 'b', label: 'Beta' }], selection: { mode: 'multiple', array: true }, value: [] },
          },
        },
      );
      const fields = [...bar.el.querySelectorAll('.var-field')];
      expect(fields.map((f) => f.querySelector('.var-name')!.textContent)).toEqual(['y', 'x']);
      expect(fields.map((f) => f.classList.contains('is-optional'))).toEqual([false, true]);
      expect(fields.every((f) => f.querySelector('.ms-field') !== null)).toBe(true);
    });

    it('a single-select curated field over an Array(...) contract commits a WRAPPED [value]/[] instead of a bare scalar', () => {
      const app = makeApp();
      const onApplyCurated = vi.fn();
      const bar = buildFilterBar(app, paramsFor('SELECT {x:String}'), () => {}, okField, {
        curatedFields: {
          x: { options: [{ value: 'a', label: 'Alpha' }], selection: { mode: 'single', array: true } },
        },
        onApplyCurated,
      });
      document.body.appendChild(bar.el);
      bar.el.querySelector('input')!.dispatchEvent(new Event('focus'));
      bar.el.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      expect(onApplyCurated).toHaveBeenCalledWith('x', ['a'], true);
      bar.el.querySelector('.var-combo-clear-inline')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onApplyCurated).toHaveBeenCalledWith('x', [], false);
      bar.el.remove();
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
