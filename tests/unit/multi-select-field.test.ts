import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildMultiSelectField } from '../../src/ui/multi-select-field.js';
import type { MultiSelectFieldOpts, MultiSelectFieldHandle } from '../../src/ui/multi-select-field.js';

// The searchable multiselect for an `Array(scalar T)` Dashboard variable (#189,
// restored onto the inferred-Variables model). Same local-factory + spy + real
// DOM convention as `variable-option-field.test.ts` — no fake app, no snapshots:
// every assertion is on a class, an ARIA attribute, or textContent, because
// those ARE the contract a screen reader and the CSS both read.

const OPTIONS = [
  { value: 'de', label: 'Germany' },
  { value: 'fr', label: 'France' },
  { value: 'es', label: 'Spain' },
];

const fields: MultiSelectFieldHandle[] = [];
afterEach(() => { for (const f of fields.splice(0)) f.dispose(); });

function build(over: Partial<MultiSelectFieldOpts> = {}) {
  const onApply = vi.fn();
  const field = buildMultiSelectField({
    document, name: 'country', options: OPTIONS, selected: [], active: false, onApply, ...over,
  });
  fields.push(field);
  document.body.replaceChildren(field.el);
  return { field, onApply, trigger: field.el.querySelector<HTMLButtonElement>('.ms-trigger')! };
}

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('.ms-popover')!;
const search = (): HTMLInputElement => dialog().querySelector<HTMLInputElement>('.ms-search')!;
const selectAll = (): HTMLInputElement => dialog().querySelector<HTMLInputElement>('.ms-select-all-cb')!;
const rows = (): HTMLElement[] => [...dialog().querySelectorAll<HTMLElement>('.ms-option')];
const boxes = (): HTMLInputElement[] =>
  [...dialog().querySelectorAll<HTMLInputElement>('.ms-option input[type="checkbox"]')];
const visibleLabels = (): string[] => rows().filter((r) => !r.hidden)
  .map((r) => r.querySelector('.ms-option-label')!.textContent ?? '');
const live = (): string => dialog().querySelector('.ms-live')!.textContent ?? '';
const btn = (cls: string): HTMLButtonElement => dialog().querySelector<HTMLButtonElement>(cls)!;
const check = (cb: HTMLInputElement, next: boolean): void => {
  cb.checked = next;
  cb.dispatchEvent(new Event('change'));
};
const type = (text: string): void => {
  search().value = text;
  search().dispatchEvent(new Event('input'));
};

describe('trigger text and accessible name', () => {
  it('reads Not set when nothing is committed', () => {
    expect(build().trigger.textContent).toBe('Not set');
  });

  it('reads Not set when a selection exists but the variable is inactive', () => {
    // Activation is authoritative — a dormant value is never presented as bound.
    expect(build({ selected: ['de', 'fr'], active: false }).trigger.textContent).toBe('Not set');
  });

  it('reads the single option LABEL when exactly one is selected', () => {
    expect(build({ selected: ['de'], active: true }).trigger.textContent).toBe('Germany');
  });

  it('falls back to the raw value when the single selection has no matching option', () => {
    // A dormant value a refresh dropped must not read as blank.
    expect(build({ selected: ['gone'], active: true }).trigger.textContent).toBe('gone');
  });

  it('counts beyond one', () => {
    expect(build({ selected: ['de', 'fr'], active: true }).trigger.textContent).toBe('2 selected');
  });

  it('names itself, and its selected count, for assistive tech', () => {
    const { trigger } = build({ selected: ['de', 'fr'], active: true });
    expect(trigger.getAttribute('aria-label')).toBe('country variable, 2 selected');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.id).toBe('ms-trigger-country');
  });

  it('carries the caller title, or the bare name without one', () => {
    expect(build({ title: 'country: Array(String)' }).trigger.title).toBe('country: Array(String)');
    expect(build().trigger.title).toBe('country');
  });

  it('defaults to the ambient document when none is injected', () => {
    const field = buildMultiSelectField({ name: 'c', options: [], selected: [], active: false, onApply: () => {} });
    fields.push(field);
    expect(field.el.querySelector('.ms-trigger')).not.toBeNull();
  });
});

describe('opening', () => {
  it('mounts a named modal dialog and focuses the search box', () => {
    const { trigger } = build();
    trigger.click();
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(dialog().getAttribute('aria-label')).toBe('country options');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute('aria-label')).toBe('Search country options');
    expect(search().placeholder).toBe('Search country options');
  });

  it('seeds the draft from the committed selection', () => {
    build({ selected: ['de', 'es'], active: true }).trigger.click();
    expect(boxes().map((cb) => cb.checked)).toEqual([true, false, true]);
  });

  it('never stacks a second popover', () => {
    const { trigger } = build();
    trigger.click();
    trigger.click();
    expect(document.querySelectorAll('.ms-popover')).toHaveLength(1);
  });

  it('reports whether it is open', () => {
    const { field, trigger } = build();
    expect(field.isOpen()).toBe(false);
    trigger.click();
    expect(field.isOpen()).toBe(true);
    btn('.ms-btn:not(.ms-btn-clear):not(.ms-btn-primary)').click();
    expect(field.isOpen()).toBe(false);
  });
});

describe('search', () => {
  it('filters on label, case-insensitively, and reports the count', () => {
    build().trigger.click();
    type('ger');
    expect(visibleLabels()).toEqual(['Germany']);
    expect(live()).toBe('1 of 3 options');
  });

  it('filters on VALUE too, not just the visible label', () => {
    build().trigger.click();
    type('es');
    // 'es' matches Spain by value, and France by its label ('France' has no
    // 'es'… but 'Spain' does not either) — value matching is what finds it.
    expect(visibleLabels()).toEqual(['Spain']);
  });

  it('shows everything for blank or whitespace-only text', () => {
    build().trigger.click();
    type('ger');
    type('   ');
    expect(visibleLabels()).toHaveLength(3);
    expect(live()).toBe('3 of 3 options');
  });

  it('can match nothing', () => {
    build().trigger.click();
    type('zzz');
    expect(visibleLabels()).toEqual([]);
    expect(live()).toBe('0 of 3 options');
  });
});

describe('select visible', () => {
  it('starts unchecked, goes indeterminate, then checked', () => {
    build().trigger.click();
    expect(selectAll().checked).toBe(false);
    expect(selectAll().indeterminate).toBe(false);
    expect(selectAll().getAttribute('aria-label')).toBe('Select all 3 visible options');

    check(boxes()[0], true);
    expect(selectAll().checked).toBe(false);
    expect(selectAll().indeterminate).toBe(true);

    check(boxes()[1], true);
    check(boxes()[2], true);
    expect(selectAll().checked).toBe(true);
    expect(selectAll().indeterminate).toBe(false);
    expect(selectAll().getAttribute('aria-label')).toBe('Clear all 3 visible options');
  });

  it('unchecking a box leaves the draft', () => {
    build({ selected: ['de'], active: true }).trigger.click();
    check(boxes()[0], false);
    expect(selectAll().indeterminate).toBe(false);
    expect(selectAll().checked).toBe(false);
  });

  it('affects ONLY the filtered subset, leaving hidden selections alone', () => {
    const { onApply, trigger } = build();
    trigger.click();
    check(boxes()[0], true);      // Germany, which the filter below hides
    type('ran');                  // France only
    expect(visibleLabels()).toEqual(['France']);
    check(selectAll(), true);
    btn('.ms-btn-primary').click();
    // Germany survived even though it was hidden when Select visible ran.
    expect(onApply).toHaveBeenCalledWith(['de', 'fr'], true);
  });

  it('clears only the filtered subset', () => {
    const { onApply, trigger } = build({ selected: ['de', 'fr'], active: true });
    trigger.click();
    type('ran');
    check(selectAll(), false);
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith(['de'], true);
  });

  it('reports zero visible options as neither checked nor mixed', () => {
    build().trigger.click();
    type('zzz');
    expect(selectAll().checked).toBe(false);
    expect(selectAll().indeterminate).toBe(false);
    expect(selectAll().getAttribute('aria-label')).toBe('Select all 0 visible options');
  });
});

describe('Clear / Cancel / Apply', () => {
  it('Clear empties the WHOLE draft, not just the visible subset', () => {
    const { trigger } = build({ selected: ['de', 'fr', 'es'], active: true });
    trigger.click();
    type('ran');                 // only France visible
    btn('.ms-btn-clear').click();
    type('');
    expect(boxes().map((cb) => cb.checked)).toEqual([false, false, false]);
  });

  it('Clear then Apply returns the variable to unset', () => {
    const { onApply, trigger } = build({ selected: ['de'], active: true });
    trigger.click();
    btn('.ms-btn-clear').click();
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith([], false);
  });

  it('Apply canonicalizes by OPTION order, not click order', () => {
    const { onApply, trigger } = build();
    trigger.click();
    check(boxes()[2], true);     // Spain first
    check(boxes()[0], true);     // then Germany
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith(['de', 'es'], true);
  });

  it('Apply closes BEFORE it commits', () => {
    // The shared popover contract: a subscriber rebuilding the bar inside the
    // commit's synchronous publish must observe this popover as already closed.
    const { field, trigger } = build();
    let openAtCommit: boolean | null = null;
    fields.pop();
    const f = buildMultiSelectField({
      document, name: 'country', options: OPTIONS, selected: [], active: false,
      onApply: () => { openAtCommit = f.isOpen(); },
    });
    fields.push(f);
    document.body.replaceChildren(f.el);
    f.el.querySelector<HTMLButtonElement>('.ms-trigger')!.click();
    check(boxes()[0], true);
    btn('.ms-btn-primary').click();
    expect(openAtCommit).toBe(false);
    expect(field.isOpen()).toBe(false);
    expect(trigger).toBeDefined();
  });

  it('a no-op Apply closes silently', () => {
    const { field, onApply, trigger } = build({ selected: ['de'], active: true });
    trigger.click();
    btn('.ms-btn-primary').click();
    expect(onApply).not.toHaveBeenCalled();
    expect(field.isOpen()).toBe(false);
  });

  it('an Apply that only changes activation still commits', () => {
    // Same canonical values, different active flag — the value did change.
    const { onApply, trigger } = build({ selected: ['de'], active: false });
    trigger.click();
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith(['de'], true);
  });

  it('Cancel discards the draft and writes nothing', () => {
    const { field, onApply, trigger } = build();
    trigger.click();
    check(boxes()[0], true);
    btn('.ms-btn:not(.ms-btn-clear):not(.ms-btn-primary)').click();
    expect(onApply).not.toHaveBeenCalled();
    expect(field.isOpen()).toBe(false);
    // Re-opening starts from committed truth, not the discarded draft.
    trigger.click();
    expect(boxes().map((cb) => cb.checked)).toEqual([false, false, false]);
  });

  it('Escape discards the draft', () => {
    const { field, onApply, trigger } = build();
    trigger.click();
    check(boxes()[0], true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(field.isOpen()).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('drops a selected value the option list does not offer', () => {
    // Apply canonicalizes against the authoritative list, so a dormant value
    // cannot be silently re-committed.
    const { onApply, trigger } = build({ selected: ['de', 'gone'], active: true });
    trigger.click();
    check(boxes()[1], true);
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith(['de', 'fr'], true);
  });
});

// The server caps each option branch, so a returned list can be a PREFIX and a
// committed value may be valid yet absent from it. The session already declines
// to prune one; without the same rule here, the control's own Apply would undo
// that preservation one layer up.
describe('an INCOMPLETE option list', () => {
  const partial = { options: OPTIONS, selected: ['gone-past-the-cap'], active: true, incomplete: true };

  it('shows an off-list committed value verbatim', () => {
    expect(build(partial).trigger.textContent).toBe('gone-past-the-cap');
  });

  it('a no-change Apply commits nothing', () => {
    const { onApply, trigger } = build(partial);
    trigger.click();
    btn('.ms-btn-primary').click();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('picking a visible value KEEPS the off-list one', () => {
    const { onApply, trigger } = build(partial);
    trigger.click();
    check(boxes()[1], true);
    btn('.ms-btn-primary').click();
    // Visible picks canonicalize by option order; the invisible value the user
    // could not have deselected is appended, in committed order.
    expect(onApply).toHaveBeenCalledWith(['fr', 'gone-past-the-cap'], true);
  });

  it('keeps SEVERAL off-list values, in committed order', () => {
    const { onApply, trigger } = build({
      ...partial, selected: ['zz-past', 'de', 'aa-past'],
    });
    trigger.click();
    btn('.ms-btn-primary').click();
    expect(onApply).not.toHaveBeenCalled(); // still a no-op
    trigger.click(); // Apply closed it; re-open to make a real change
    check(boxes()[1], true);
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith(['de', 'fr', 'zz-past', 'aa-past'], true);
  });

  it('Clear still removes them — it is the explicit "remove everything"', () => {
    const { onApply, trigger } = build(partial);
    trigger.click();
    btn('.ms-btn-clear').click();
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith([], false);
  });

  it('does NOT preserve off-list values once the list is complete', () => {
    // A complete list means the value genuinely went away, and the session has
    // already reconciled it out — keeping it here would resurrect it.
    const { onApply, trigger } = build({ ...partial, incomplete: false });
    trigger.click();
    check(boxes()[1], true);
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith(['fr'], true);
  });

  it('setOptions can turn the flag on and off with the list', () => {
    const { field, onApply, trigger } = build({
      options: OPTIONS, selected: ['past-the-cap'], active: true, incomplete: false,
    });
    // A later refresh comes back truncated: the value is preserved from then on.
    field.setOptions(OPTIONS, true);
    trigger.click();
    btn('.ms-btn-primary').click();
    expect(onApply).not.toHaveBeenCalled();
    // And a complete refresh drops it again.
    field.setOptions(OPTIONS, false);
    trigger.click();
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith([], false);
  });

  it('defaults to complete when setOptions omits the flag', () => {
    const { field, onApply, trigger } = build(partial);
    field.setOptions(OPTIONS);
    trigger.click();
    btn('.ms-btn-primary').click();
    expect(onApply).toHaveBeenCalledWith([], false);
  });
});

describe('setOptions', () => {
  it('swaps the list and re-renders the committed label', () => {
    const { field, trigger } = build({ selected: ['de'], active: true });
    expect(trigger.textContent).toBe('Germany');
    field.setOptions([{ value: 'de', label: 'Deutschland' }]);
    expect(trigger.textContent).toBe('Deutschland');
    trigger.click();
    expect(visibleLabels()).toEqual(['Deutschland']);
  });

  it('cancels an open popover — its draft was built against the old generation', () => {
    const { field, onApply, trigger } = build();
    trigger.click();
    check(boxes()[0], true);
    field.setOptions([{ value: 'es', label: 'Spain' }]);
    expect(field.isOpen()).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('never re-commits — an options refresh is not a user choice', () => {
    const { field, onApply } = build({ selected: ['de'], active: true });
    field.setOptions([]);
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('loading', () => {
  // The surface is mounted BEFORE `session.start()` resolves, so a configured
  // variable is on screen for the whole option request. Left operable, a
  // no-change Apply would canonicalize a restored selection against the empty
  // list that has not arrived yet — and commit a clear.
  it('refuses to open while the option batch is in flight', () => {
    const { field, trigger } = build({ selected: ['de', 'fr'], active: true, options: [], loading: true });
    expect(trigger.textContent).toBe('Loading options…');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(trigger.classList.contains('is-loading')).toBe(true);
    expect(trigger.title).toContain('Loading');
    // Not `disabled` — the reason must stay reachable, and focus must not drop.
    expect(trigger.disabled).toBe(false);
    trigger.click();
    expect(document.querySelector('.ms-popover')).toBeNull();
    expect(field.isOpen()).toBe(false);
  });

  it('cannot clear a restored selection before its options arrive', () => {
    // The exact reviewer scenario, end to end.
    const { field, onApply, trigger } = build({
      selected: ['de', 'fr'], active: true, options: [], loading: true,
    });
    trigger.click();
    (document.querySelector('.ms-btn-primary') as HTMLButtonElement | null)?.click();
    expect(onApply).not.toHaveBeenCalled();
    field.setOptions(OPTIONS);
    // Once the list lands the control is operable and the selection is intact.
    expect(trigger.textContent).toBe('2 selected');
    trigger.click();
    expect(boxes().map((cb) => cb.checked)).toEqual([true, true, false]);
  });

  it('setOptions is what makes it operable, and restores the real trigger text', () => {
    const { field, trigger } = build({ selected: ['de'], active: true, options: [], loading: true });
    field.setOptions(OPTIONS);
    expect(trigger.getAttribute('aria-disabled')).toBe('false');
    expect(trigger.getAttribute('aria-busy')).toBe('false');
    expect(trigger.classList.contains('is-loading')).toBe(false);
    expect(trigger.textContent).toBe('Germany');
    trigger.click();
    expect(document.querySelector('.ms-popover')).not.toBeNull();
  });

  it('a batch failure also ends the wait, and reports the failure instead', () => {
    // Leaving `loading` set would keep promising a list that is not coming.
    const { trigger } = build({ selected: ['de'], active: true, options: [], loading: true });
    fields[fields.length - 1].setUnavailable('Variable options could not be loaded.');
    expect(trigger.classList.contains('is-loading')).toBe(false);
    expect(trigger.classList.contains('is-error')).toBe(true);
    expect(trigger.getAttribute('aria-busy')).toBe('false');
    expect(trigger.title).toBe('Variable options could not be loaded.');
    // Still inert, for the other reason.
    trigger.click();
    expect(document.querySelector('.ms-popover')).toBeNull();
  });

  it('is off by default, so a control built with its options is operable at once', () => {
    const { trigger } = build();
    expect(trigger.getAttribute('aria-busy')).toBe('false');
    expect(trigger.getAttribute('aria-disabled')).toBe('false');
    trigger.click();
    expect(document.querySelector('.ms-popover')).not.toBeNull();
  });
});

describe('setUnavailable', () => {
  it('marks the trigger without disabling it, and refuses to open', () => {
    const { field, trigger } = build();
    field.setUnavailable('Variable options could not be loaded.');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    expect(trigger.classList.contains('is-error')).toBe(true);
    expect(field.el.classList.contains('is-error')).toBe(true);
    expect(trigger.title).toBe('Variable options could not be loaded.');
    // Never `disabled` — that would make the reason unreachable and drop focus.
    expect(trigger.disabled).toBe(false);
    trigger.click();
    expect(document.querySelector('.ms-popover')).toBeNull();
  });

  it('closes an already-open popover', () => {
    const { field, trigger } = build();
    trigger.click();
    field.setUnavailable('boom');
    expect(field.isOpen()).toBe(false);
  });

  it('restores on null, back to the resting title', () => {
    const { field, trigger } = build({ title: 'country: Array(String)' });
    field.setUnavailable('boom');
    field.setUnavailable(null);
    expect(trigger.getAttribute('aria-disabled')).toBe('false');
    expect(trigger.hasAttribute('aria-invalid')).toBe(false);
    expect(trigger.classList.contains('is-error')).toBe(false);
    expect(trigger.title).toBe('country: Array(String)');
    trigger.click();
    expect(document.querySelector('.ms-popover')).not.toBeNull();
  });

  it('leaves the committed selection alone', () => {
    // It is still bound into every panel that declares the name; a failed list
    // is no reason to silently change what those panels show.
    const { field, trigger } = build({ selected: ['de'], active: true });
    field.setUnavailable('boom');
    expect(trigger.textContent).toBe('Germany');
  });
});

describe('focusTrigger and dispose', () => {
  it('focuses the trigger', () => {
    const { field, trigger } = build();
    field.focusTrigger();
    expect(document.activeElement).toBe(trigger);
  });

  it('dispose while open is a silent Cancel', () => {
    const { field, onApply, trigger } = build();
    trigger.click();
    check(boxes()[0], true);
    field.dispose();
    expect(document.querySelector('.ms-popover')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('dispose unwires the trigger', () => {
    const { field, trigger } = build();
    field.dispose();
    trigger.click();
    expect(document.querySelector('.ms-popover')).toBeNull();
  });
});
