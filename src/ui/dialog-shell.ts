// The shared modal-dialog shell (#463, promoted out of `file-menu.ts` by #429
// phase 3 so the Dashboard tree's rename pencil can reuse it too — the tree
// persists across Query/Dashboard surface switches, so its own dialogs need
// the same "force-close on a surface transition" guarantee File-menu's
// already had).
//
// `openDialogShell` mounts one `.fm-dialog-backdrop`/`.fm-dialog-card`
// (title + caller-supplied content nodes), wired for Esc + outside-click
// close. `openNameDialog` is the single-field convenience wrapper every
// "New dashboard" prompt uses; a caller that needs more than one field (the
// rename pencil's title+description form) builds directly on
// `openDialogShell`.
//
// Only ONE dialog is ever meaningfully open at a time (this shell is modal —
// nothing else is meant to be reachable while one is up), so "which dialog is
// currently open" is tracked as a single module-local slot rather than a
// per-app field: any caller can force-close it via `closeOpenDialogShell()`
// without needing to know who opened it.

import { h, attachBackdropClose } from './dom.js';

export interface DialogHandle { close(): void; }

/** The narrow slice of an app controller a dialog needs: a document to mount
 *  into, and the modal keyboard-owner stack every body-mounted overlay
 *  acquires while it is open. A real `App` (file-menu.ts's callers) and the
 *  Dashboard tree's narrower `DashboardTreeApp` both satisfy this directly. */
export interface DialogHostApp {
  document: Document;
  acquireKeyboardOwner(kind: 'modal'): () => void;
}

export interface OpenDialogShellOpts {
  extraCardClass?: string;
  /** Element to return focus to when the dialog closes — `null` when there is
   *  nothing to remember (the trigger is already gone by the time the dialog
   *  mounts, as with a File-menu row: `openMenu` closes the row's menu before
   *  running the click). `focus()` on a since-detached element is a harmless
   *  no-op, so a caller may pass its own trigger button without re-checking
   *  it is still attached. */
  returnFocusTo: HTMLElement | null;
  /** Runs on every close path (Escape, outside-click, and whatever the caller's
   *  own content wires up) — AFTER `returnFocusTo` is focused, never before. A
   *  trigger that is only revealed on hover/`:focus-within` (the Dashboard-tree
   *  pencil, `.dash-tree-rename-btn`) must stay revealed (e.g. `aria-expanded`
   *  kept `"true"` by the caller) right up through the `focus()` call below —
   *  by the time a dialog closes the pointer has typically moved onto the
   *  dialog's own controls, so neither `:hover` nor `:focus-within` still holds
   *  on the row, and `focus()` on an already-`display: none` element is a
   *  silent no-op in a real browser (invisible to happy-dom, which enforces no
   *  CSS layout at all — only e2e caught this). Once focus lands ON the
   *  trigger, `:focus-within` covers it independently, so `onClose` resetting
   *  the trigger's own reveal signal here is safe — it no longer needs one. */
  onClose?: () => void;
}

let openHandle: { backdrop: Element; close: () => void } | null = null;

/** Force-close whatever dialog `openDialogShell` currently has open, if any —
 *  the same teardown every surface transition already runs for anchored
 *  popovers and the doc pane. A no-op when nothing is open. */
export function closeOpenDialogShell(): void {
  openHandle?.close();
}

export function openDialogShell(
  app: DialogHostApp, title: string, content: unknown[], opts: OpenDialogShellOpts,
): DialogHandle {
  const doc = app.document;
  const releaseKeyboard = app.acquireKeyboardOwner('modal');
  let backdrop: HTMLElement;
  const close = (): void => {
    doc.removeEventListener('keydown', onKey, true);
    detachBackdrop();
    // Guard against a STALE dialog's close clobbering a newer one's tracked
    // reference — the same check `app.dom.fileDialog === backdrop` used to make
    // before this shell was generalized to a single module-local slot.
    if (openHandle?.backdrop === backdrop) openHandle = null;
    backdrop.remove();
    releaseKeyboard();
    opts.returnFocusTo?.focus();
    opts.onClose?.();
  };
  /** Everything inside the card a Tab can land on, in DOM order. Disabled
   *  controls are excluded — the name dialog's confirm is disabled while the
   *  name is empty, and tabbing onto an inert button is a dead stop. */
  const focusables = (): HTMLElement[] =>
    [...card.querySelectorAll<HTMLElement>('button, input, select, textarea')]
      .filter((el) => !(el as HTMLButtonElement).disabled);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the card. `openDialogShell` mounts a MODAL, but nothing
    // else makes the page behind it unreachable — so without this a keyboard
    // user tabs straight out of a dialog they cannot see they have left.
    const items = focusables();
    const edge = e.shiftKey ? items[0] : items[items.length - 1];
    const wrapTo = e.shiftKey ? items[items.length - 1] : items[0];
    if (doc.activeElement === edge) { e.preventDefault(); wrapTo.focus(); }
    else if (!card.contains(doc.activeElement)) { e.preventDefault(); items[0].focus(); }
  };
  const card = h('div', { class: opts.extraCardClass ? `fm-dialog-card ${opts.extraCardClass}` : 'fm-dialog-card' },
    h('div', { class: 'fm-dialog-title' }, title), content);
  backdrop = h('div', { class: 'fm-dialog-backdrop' }, card);
  const detachBackdrop = attachBackdropClose(backdrop, close);
  const handle: DialogHandle = { close };
  openHandle = { backdrop, close };
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
  return handle;
}

export interface NameDialogOpts {
  title: string;
  /** The input's visible + accessible label — the two are the same element. */
  label: string;
  initial: string;
  confirmLabel: string;
  returnFocusTo: HTMLElement | null;
  /** Called with the TRIMMED name, only on a real commit. */
  onConfirm: (name: string) => void;
}

/**
 * Ask for one name (#463 — New dashboard was the first caller), on the same
 * `.fm-dialog-*` shell as the confirm/conflict/picker dialogs, so Escape,
 * outside-click and surface-exit teardown all behave identically.
 *
 * The name is trimmed once, at the boundary, and a whitespace-only name commits
 * NOTHING: the confirm button stays disabled, so there is no reachable state in
 * which the caller has to defend against an empty title. Enter is the same
 * commit as the button (and equally refused when empty); Escape cancels through
 * the shell. Duplicate names are allowed and deliberately not validated —
 * identity is the id.
 */
export function openNameDialog(
  app: DialogHostApp, { title, label, initial, confirmLabel, returnFocusTo, onConfirm }: NameDialogOpts,
): void {
  const input = h('input', {
    class: 'fm-dialog-input', type: 'text', id: 'fm-name-input', value: initial, spellcheck: 'false',
  }) as HTMLInputElement;
  const confirm = h('button', {
    class: 'fm-dialog-confirm',
    onclick: () => commit(),
  }, confirmLabel) as HTMLButtonElement;
  const commit = (): void => {
    const name = input.value.trim();
    if (!name) return;
    handle.close();
    onConfirm(name);
  };
  const sync = (): void => { confirm.disabled = input.value.trim() === ''; };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => {
    // Escape is the shell's, on a capture-phase document listener; only Enter is
    // ours, and only because a single-field dialog has no form to submit.
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
  const handle = openDialogShell(app, title, [
    h('div', { class: 'fm-dialog-body' },
      h('label', { class: 'fm-dialog-label', for: 'fm-name-input' }, label), input),
    h('div', { class: 'fm-dialog-actions' },
      h('button', { class: 'fm-dialog-cancel', onclick: () => handle.close() }, 'Cancel'),
      confirm),
  ], { returnFocusTo });
  sync();
  // Same deferred focus+select as the inline workspace rename: the card is in
  // the document by now, and selecting the default name makes typing over it the
  // one-keystroke path.
  setTimeout(() => { input.focus(); input.select(); });
}
