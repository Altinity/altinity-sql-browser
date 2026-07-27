// The shared modal-dialog shell (#429 phase 3, promoted out of `file-menu.ts`
// so the Dashboard tree's rename pencil can reuse it). `file-menu.test.ts`
// exercises this module extensively end-to-end (New dashboard, the conflict
// dialog, the Dashboard picker) — what's tested here is the module's OWN
// contract in isolation, plus the two behaviors this promotion introduced:
// an explicit `returnFocusTo` (replacing the hardcoded File-menu-button
// restore) and `closeOpenDialogShell()`'s single-slot staleness guard.

import { describe, it, expect } from 'vitest';
import { closeOpenDialogShell, openDialogShell, openNameDialog } from '../../src/ui/dialog-shell.js';
import { h } from '../../src/ui/dom.js';
import { makeApp } from '../helpers/fake-app.js';

const key = (target: EventTarget, k: string): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const click = (el: Element): boolean => el.dispatchEvent(new Event('click', { bubbles: true }));
const mousedown = (el: Element): boolean => el.dispatchEvent(new Event('mousedown', { bubbles: true }));
const backdropOf = (): HTMLElement | null => document.querySelector('.fm-dialog-backdrop');

describe('openNameDialog', () => {
  it('renders the title/label/initial value and confirm label', () => {
    const app = makeApp();
    openNameDialog(app, {
      title: 'New dashboard', label: 'Dashboard name', initial: 'Dashboard',
      confirmLabel: 'Create dashboard', returnFocusTo: null, onConfirm: () => {},
    });
    expect(document.querySelector('.fm-dialog-title')!.textContent).toBe('New dashboard');
    expect(document.querySelector('.fm-dialog-label')!.textContent).toBe('Dashboard name');
    expect((document.querySelector('.fm-dialog-input') as HTMLInputElement).value).toBe('Dashboard');
    expect(document.querySelector('.fm-dialog-confirm')!.textContent).toBe('Create dashboard');
  });

  it('commits the TRIMMED name on Enter and closes', () => {
    const app = makeApp();
    let committed: string | undefined;
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: '', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: (name) => { committed = name; },
    });
    const input = document.querySelector('.fm-dialog-input') as HTMLInputElement;
    input.value = '  Sales revenue  ';
    key(input, 'Enter');
    expect(committed).toBe('Sales revenue');
    expect(backdropOf()).toBeNull();
  });

  it('commits on a confirm-button click too', () => {
    const app = makeApp();
    let committed: string | undefined;
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: (name) => { committed = name; },
    });
    click(document.querySelector('.fm-dialog-confirm')!);
    expect(committed).toBe('Dashboard');
  });

  it('disables confirm on a blank/whitespace-only name, and Enter commits nothing', () => {
    const app = makeApp();
    let called = false;
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: () => { called = true; },
    });
    const input = document.querySelector('.fm-dialog-input') as HTMLInputElement;
    const confirm = document.querySelector('.fm-dialog-confirm') as HTMLButtonElement;
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(true);
    key(input, 'Enter');
    expect(called).toBe(false);
    expect(backdropOf()).not.toBeNull();
  });

  it('Cancel closes and commits nothing', () => {
    const app = makeApp();
    let called = false;
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: () => { called = true; },
    });
    click(document.querySelector('.fm-dialog-cancel')!);
    expect(called).toBe(false);
    expect(backdropOf()).toBeNull();
  });

  it('Escape closes and commits nothing', () => {
    const app = makeApp();
    let called = false;
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: () => { called = true; },
    });
    key(document, 'Escape');
    expect(called).toBe(false);
    expect(backdropOf()).toBeNull();
  });

  it('an outside (backdrop) click closes and commits nothing', () => {
    const app = makeApp();
    let called = false;
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: () => { called = true; },
    });
    const backdrop = backdropOf()!;
    mousedown(backdrop);
    click(backdrop);
    expect(called).toBe(false);
    expect(backdropOf()).toBeNull();
  });

  it('a click that starts inside the card and releases on the backdrop does not close it', () => {
    // Guards a text-selection drag that ends outside the card from being
    // mistaken for an outside click — the same contract `attachBackdropClose`
    // (dom.ts) already holds for every other overlay.
    const app = makeApp();
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: () => {},
    });
    const backdrop = backdropOf()!;
    const card = document.querySelector('.fm-dialog-card')!;
    mousedown(card);
    click(backdrop);
    expect(backdropOf()).not.toBeNull();
  });

  it('returns focus to the given element on close', () => {
    const app = makeApp();
    const trigger = h('button', {}, 'Edit') as HTMLButtonElement;
    document.body.appendChild(trigger);
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: trigger, onConfirm: () => {},
    });
    click(document.querySelector('.fm-dialog-cancel')!);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('a null returnFocusTo is a no-op — nothing to remember, nothing to restore', () => {
    const app = makeApp();
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: () => {},
    });
    expect(() => click(document.querySelector('.fm-dialog-cancel')!)).not.toThrow();
  });

  it('acquires and releases the modal keyboard owner', () => {
    const app = makeApp();
    openNameDialog(app, {
      title: 'New dashboard', label: 'Name', initial: 'Dashboard', confirmLabel: 'Create',
      returnFocusTo: null, onConfirm: () => {},
    });
    expect(app.keyboardOwner?.kind).toBe('modal');
    click(document.querySelector('.fm-dialog-cancel')!);
    expect(app.keyboardOwner?.kind).not.toBe('modal');
  });
});

describe('openDialogShell — Tab trap', () => {
  it('wraps Tab from the last focusable to the first, and Shift+Tab the other way', () => {
    const app = makeApp();
    const first = h('button', {}, 'First') as HTMLButtonElement;
    const last = h('button', {}, 'Last') as HTMLButtonElement;
    openDialogShell(app, 'Title', [first, last], { returnFocusTo: null });
    last.focus();
    const tab = document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(tab).toBe(false); // preventDefault() was called
    expect(document.activeElement).toBe(first);
    const shiftTab = document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(shiftTab).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it('excludes disabled controls from the Tab order', () => {
    const app = makeApp();
    const first = h('button', { disabled: true }, 'Disabled') as HTMLButtonElement;
    const middle = h('button', {}, 'Middle') as HTMLButtonElement;
    openDialogShell(app, 'Title', [first, middle], { returnFocusTo: null });
    middle.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(middle);
  });
});

describe('closeOpenDialogShell', () => {
  it('is a no-op when nothing is open', () => {
    expect(() => closeOpenDialogShell()).not.toThrow();
    expect(backdropOf()).toBeNull();
  });

  it('force-closes whatever dialog is currently open', () => {
    const app = makeApp();
    openDialogShell(app, 'Title', [h('span', {}, 'Body')], { returnFocusTo: null });
    expect(backdropOf()).not.toBeNull();
    closeOpenDialogShell();
    expect(backdropOf()).toBeNull();
  });

  it('a STALE dialog closing on its own does not clobber a NEWER one\'s tracked slot', () => {
    const app = makeApp();
    const handleA = openDialogShell(app, 'A', [h('span', {}, 'A body')], { returnFocusTo: null });
    // A second dialog opens without the first being closed first (the modal
    // keyboard-owner stack does not itself prevent this).
    openDialogShell(app, 'B', [h('span', {}, 'B body')], { returnFocusTo: null });
    expect(document.querySelectorAll('.fm-dialog-backdrop').length).toBe(2);

    // A's own close must remove only ITS backdrop, and must not null out the
    // module's "currently open" slot — which by now points at B, not A.
    handleA.close();
    expect(document.querySelectorAll('.fm-dialog-backdrop').length).toBe(1);
    expect(document.querySelector('.fm-dialog-title')!.textContent).toBe('B');

    // The slot still resolves to B, so a surface-transition teardown reaches it.
    closeOpenDialogShell();
    expect(backdropOf()).toBeNull();
  });
});
