// The shared modal-dialog shell (#429 phase 3, promoted out of `file-menu.ts`
// so the Dashboard tree's rename pencil can reuse it). `file-menu.test.ts`
// exercises this module extensively end-to-end (New dashboard, the conflict
// dialog, the Dashboard picker) — what's tested here is the module's OWN
// contract in isolation, plus the two behaviors this promotion introduced:
// an explicit `returnFocusTo` (replacing the hardcoded File-menu-button
// restore) and `closeOpenDialogShell()`'s single-slot staleness guard.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  closeOpenDialogShell, openDialogShell, openMetadataDialog, openNameDialog,
} from '../../src/ui/dialog-shell.js';
import type { DialogHandle } from '../../src/ui/dialog-shell.js';
import { h } from '../../src/ui/dom.js';
import { makeApp } from '../helpers/fake-app.js';

const key = (target: EventTarget, k: string): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const click = (el: Element): boolean => el.dispatchEvent(new Event('click', { bubbles: true }));
const mousedown = (el: Element): boolean => el.dispatchEvent(new Event('mousedown', { bubbles: true }));
const backdropOf = (): HTMLElement | null => document.querySelector('.fm-dialog-backdrop');

/** Dialogs opened by a test that does not close them itself. Every shell
 *  installs a CAPTURE-phase document `keydown` listener that outlives its
 *  node, so one left mounted answers a later test's Tab before that test's own
 *  dialog does — closing is the only real teardown. */
const opened: DialogHandle[] = [];
const track = (handle: DialogHandle): DialogHandle => { opened.push(handle); return handle; };
afterEach(() => { while (opened.length) opened.pop()!.close(); });

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

// #495 review 4: the Tab trap alone made the card behave like a modal for a
// sighted keyboard user while telling assistive technology nothing at all.
describe('openDialogShell — dialog semantics', () => {
  it('marks the card as a modal dialog named by its own title', () => {
    const app = makeApp();
    track(openDialogShell(app, 'Edit dashboard', [h('span', {}, 'Body')], { returnFocusTo: null }));
    const card = document.querySelector('.fm-dialog-card')!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    const titleId = card.getAttribute('aria-labelledby')!;
    expect(titleId).not.toBe('');
    const title = document.getElementById(titleId)!;
    expect(title.classList.contains('fm-dialog-title')).toBe(true);
    expect(title.textContent).toBe('Edit dashboard');
  });

  it('gives two coexisting dialogs distinct title ids', () => {
    // A stale dialog can still be mounted while a newer one opens; a shared
    // constant id would make both `aria-labelledby`s resolve to the first.
    const app = makeApp();
    track(openDialogShell(app, 'A', [h('span', {}, 'a')], { returnFocusTo: null }));
    track(openDialogShell(app, 'B', [h('span', {}, 'b')], { returnFocusTo: null }));
    const [a, b] = [...document.querySelectorAll('.fm-dialog-card')];
    expect(a.getAttribute('aria-labelledby')).not.toBe(b.getAttribute('aria-labelledby'));
    expect(document.getElementById(a.getAttribute('aria-labelledby')!)!.textContent).toBe('A');
    expect(document.getElementById(b.getAttribute('aria-labelledby')!)!.textContent).toBe('B');
  });
});

describe('openMetadataDialog', () => {
  const nameInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>('#pnl-name')!;
  const descInput = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('#pnl-description')!;
  const save = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.fm-dialog-confirm')!;
  const cancelBtn = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!;
  const errorEl = (): HTMLParagraphElement => document.querySelector<HTMLParagraphElement>('.fm-dialog-error')!;
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

  const open = (
    onConfirm: (values: { name: string; description: string }) => Promise<string | null>,
    over: Partial<Parameters<typeof openMetadataDialog>[1]> = {},
  ) => track(openMetadataDialog(makeApp(), {
    title: 'Edit panel', nameLabel: 'Name', descriptionLabel: 'Description',
    name: 'Revenue', description: 'By region', confirmLabel: 'Save',
    idPrefix: 'pnl', returnFocusTo: null, onConfirm, ...over,
  }));

  it('prefills both fields, labels them, and names the dialog', () => {
    open(async () => null);
    expect(document.querySelector('.fm-dialog-card')!.getAttribute('role')).toBe('dialog');
    expect(nameInput().value).toBe('Revenue');
    expect(descInput().value).toBe('By region');
    expect(document.querySelector('label[for="pnl-name"]')!.textContent).toBe('Name');
    expect(document.querySelector('label[for="pnl-description"]')!.textContent).toBe('Description');
    expect(save().textContent).toBe('Save');
    expect(errorEl().hidden).toBe(true);
  });

  it('commits the TRIMMED name with the description verbatim, and closes on success', async () => {
    const onConfirm = vi.fn(async () => null);
    open(onConfirm);
    nameInput().value = '  Revenue by region  ';
    descInput().value = 'line one\nline two';
    save().click();
    await settle();
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
      name: 'Revenue by region', description: 'line one\nline two',
    });
    expect(backdropOf()).toBeNull();
  });

  it('Enter in the name field commits; Enter in the description does not', async () => {
    const onConfirm = vi.fn(async () => null);
    open(onConfirm);
    key(descInput(), 'Enter');
    expect(onConfirm).not.toHaveBeenCalled();
    key(nameInput(), 'Enter');
    await settle();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('refuses a blank name: Save is disabled and Enter commits nothing', async () => {
    const onConfirm = vi.fn(async () => null);
    open(onConfirm);
    nameInput().value = '   ';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    expect(save().disabled).toBe(true);
    key(nameInput(), 'Enter');
    await settle();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(backdropOf()).not.toBeNull();
  });

  it('keeps the card, the typed values and the controls when the commit reports a failure', async () => {
    open(async () => 'That dashboard is no longer part of this workspace.');
    nameInput().value = 'Kept';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    save().click();
    await settle();
    expect(backdropOf()).not.toBeNull();
    expect(nameInput().value).toBe('Kept');
    expect(errorEl().hidden).toBe(false);
    expect(errorEl().getAttribute('role')).toBe('alert');
    expect(errorEl().textContent).toBe('That dashboard is no longer part of this workspace.');
    expect(save().disabled).toBe(false);
    expect(cancelBtn().disabled).toBe(false);
    expect(document.activeElement).toBe(nameInput());
  });

  it('disables both actions while a commit is in flight, so the same write cannot be submitted twice', async () => {
    let release = (): void => {};
    const onConfirm = vi.fn(() => new Promise<string | null>((resolve) => { release = () => resolve(null); }));
    open(onConfirm);
    save().click();
    expect(save().disabled).toBe(true);
    expect(cancelBtn().disabled).toBe(true);
    save().click();
    key(nameInput(), 'Enter');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(backdropOf()).toBeNull();
  });

  it('drops a late answer for a dialog that was force-closed while the write was queued', async () => {
    let release = (message: string | null): void => { void message; };
    open(() => new Promise<string | null>((resolve) => { release = resolve; }));
    save().click();
    // A surface transition tears every dialog down mid-write.
    closeOpenDialogShell();
    expect(backdropOf()).toBeNull();
    release('Storage is full');
    await settle();
    // No diagnostic is written into a detached card, and nothing reopens.
    expect(backdropOf()).toBeNull();
  });

  it('runs the caller\'s onClose and restores focus to the trigger', () => {
    const trigger = h('button', {}, 'Pencil') as HTMLButtonElement;
    document.body.appendChild(trigger);
    const onClose = vi.fn();
    const handle = open(async () => null, { returnFocusTo: trigger, onClose });
    handle.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
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
