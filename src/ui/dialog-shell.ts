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
  /**
   * Where focus goes when the dialog closes — `null` when there is nothing to
   * remember (the trigger is already gone by the time the dialog mounts, as
   * with a File-menu row: `openMenu` closes the row's menu before running the
   * click).
   *
   * Pass a FUNCTION when the trigger may not survive the dialog. Since #495
   * review 2 a metadata dialog closes only after its write ANSWERS, and that
   * write repaints the surface underneath — so the button captured at open
   * time is detached by the time focus is handed back, and `focus()` on a
   * detached element is a silent no-op that strands the keyboard on `<body>`.
   * A resolver is called at CLOSE time, so it can hand back whatever is on
   * screen now. An element (or a resolver answering one) that is merely
   * detached is still harmless — it just does nothing.
   */
  returnFocusTo: HTMLElement | (() => HTMLElement | null) | null;
  /** Runs on every close path (Escape, outside-click, and whatever the caller's
   *  own content wires up) — AFTER `returnFocusTo` is focused, never before. A
   *  trigger that is only revealed on hover/`:focus-within` (the Dashboard-tree
   *  action cluster, `.dash-tree-act`) must stay revealed (e.g. `aria-expanded`
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

/** Distinguishes one dialog's `aria-labelledby` target from the next one's.
 *  Module-local and monotonic — never reset — so a stale dialog being torn
 *  down cannot collide with the one replacing it. */
let dialogSeq = 0;

/** Force-close whatever dialog `openDialogShell` currently has open, if any —
 *  the same teardown every surface transition already runs for anchored
 *  popovers and the doc pane. A no-op when nothing is open. */
export function closeOpenDialogShell(): void {
  openHandle?.close();
}

export function openDialogShell(
  app: DialogHostApp, title: string, content: unknown[], opts: OpenDialogShellOpts,
): DialogHandle {
  // ONE modal at a time — the invariant this module's header always claimed,
  // now enforced rather than assumed. #494 requires that repeated activation
  // cannot open duplicate dialogs, and a second shell would otherwise mount a
  // second modal keyboard owner, a second capture-phase key listener, and a
  // duplicate of every `id` the caller's fields carry (two `panel-metadata-name`
  // elements break `label for` and `getById` alike). The trigger's own
  // `aria-expanded` does not close this window: a keyboard autorepeat fires
  // again while focus is still on the trigger, before the deferred focus move.
  closeOpenDialogShell();
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
    const restore = typeof opts.returnFocusTo === 'function' ? opts.returnFocusTo() : opts.returnFocusTo;
    restore?.focus();
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
  // #495 review 4: a modal that only LOOKS modal is invisible to assistive
  // technology — the Tab trap above keeps a keyboard user inside the card, but
  // without these three attributes a screen reader is never told a dialog
  // opened, never reads its name, and still exposes the page behind it. The id
  // is minted per dialog (never a constant) because two shells can briefly
  // coexist while a stale one is being force-closed, and a duplicated id would
  // point `aria-labelledby` at whichever heading the document happened to
  // match first.
  const titleId = 'fm-dialog-title-' + (++dialogSeq);
  const card = h('div', {
    class: opts.extraCardClass ? `fm-dialog-card ${opts.extraCardClass}` : 'fm-dialog-card',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
  }, h('div', { class: 'fm-dialog-title', id: titleId }, title), content);
  backdrop = h('div', { class: 'fm-dialog-backdrop' }, card);
  const detachBackdrop = attachBackdropClose(backdrop, close);
  const handle: DialogHandle = { close };
  openHandle = { backdrop, close };
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
  return handle;
}

// ── the two-field name/description metadata dialog ──────────────────────────

export interface MetadataDialogValues {
  /** Already trimmed — the dialog refuses to commit a blank name. */
  name: string;
  /** Verbatim; each commit path decides what an empty description means. */
  description: string;
}

export interface MetadataDialogOpts {
  /** Heading, and the dialog's accessible name (`Edit dashboard`). */
  title: string;
  nameLabel: string;
  descriptionLabel: string;
  name: string;
  description: string;
  confirmLabel: string;
  /** Prefix for the two field ids, so a `for`/`id` pair is unique per caller. */
  idPrefix: string;
  /** A standing caveat about what this edit will and will not change, shown
   *  from the moment the dialog opens — unlike the failure diagnostic, which
   *  appears only after a Save. #494's imported tile-title override is the
   *  case: the query name is editable, but the tile keeps rendering its own
   *  imported title, and a dialog that said nothing would look broken. */
  note?: string | null;
  returnFocusTo: OpenDialogShellOpts['returnFocusTo'];
  onClose?: () => void;
  /**
   * Commit the edit. Resolve `null` when it succeeded — the dialog closes —
   * or a message to show, keeping the dialog open with the user's text intact.
   */
  onConfirm(values: MetadataDialogValues): Promise<string | null>;
}

/**
 * Edit one resource's name + description (#429 phase 3 for a Dashboard
 * document, #494 for a panel's owned query — the second consumer that earns
 * this its place beside `openNameDialog` rather than staying colocated in
 * `ui/dashboard-tree.ts`).
 *
 * The commit is AWAITED, and that is the whole point of the shape (#495
 * review 2). The first version closed the dialog and dropped the returned
 * promise on the floor, so a concurrently deleted target, a duplicate id, a
 * validation rejection or a storage failure all presented as "the dialog
 * vanished" — with the text the user had typed gone with it. Here every
 * unsuccessful outcome keeps the card open, restores its controls and shows
 * ONE diagnostic; only a real commit closes it.
 *
 * While a commit is in flight both buttons are disabled, so the same mutation
 * cannot be submitted twice by an impatient second Enter. If the shell was
 * force-closed underneath us (a surface transition runs
 * `closeOpenDialogShell()`), the late resolution is dropped rather than
 * writing a diagnostic into a detached card.
 */
export function openMetadataDialog(app: DialogHostApp, opts: MetadataDialogOpts): DialogHandle {
  const nameId = opts.idPrefix + '-name';
  const descriptionId = opts.idPrefix + '-description';
  const nameInput = h('input', {
    class: 'fm-dialog-input', type: 'text', id: nameId, spellcheck: 'false', value: opts.name,
  }) as HTMLInputElement;
  const descInput = h('textarea', {
    class: 'fm-dialog-input fm-dialog-textarea', id: descriptionId, spellcheck: 'false',
  }) as HTMLTextAreaElement;
  descInput.value = opts.description;
  // `role="alert"` rather than a bare paragraph: the message appears long
  // after the dialog opened, in response to a Save the user has already made,
  // so it has to be announced rather than merely be present.
  const error = h('p', { class: 'fm-dialog-error', role: 'alert', hidden: true }) as HTMLParagraphElement;
  const note = opts.note ? h('p', { class: 'fm-dialog-note' }, opts.note) : null;
  const cancel = h('button', { class: 'fm-dialog-cancel', onclick: () => handle.close() }, 'Cancel') as HTMLButtonElement;
  const confirm = h('button', {
    class: 'fm-dialog-confirm',
    onclick: () => { void commit(); },
  }, opts.confirmLabel) as HTMLButtonElement;

  let closed = false;
  let inFlight = false;
  const sync = (): void => {
    // Only the CONFIRM is barred while a write is in flight — that is what
    // stops the same mutation being submitted twice. Cancel stays operable, so
    // the visible way out agrees with Escape and the backdrop, which were never
    // gated; a dialog whose only escape hatches are invisible reads as wedged.
    // Closing mid-write is safe: the late answer is dropped below rather than
    // written into a detached card.
    confirm.disabled = inFlight || nameInput.value.trim() === '';
  };
  const commit = async (): Promise<void> => {
    const name = nameInput.value.trim();
    if (!name || inFlight) return;
    inFlight = true;
    sync();
    const message = await opts.onConfirm({ name, description: descInput.value });
    // Force-closed while the write was queued: whatever it answered belongs to
    // a dialog that is no longer on screen, and its own commit path reports.
    if (closed) return;
    inFlight = false;
    sync();
    if (message === null) { handle.close(); return; }
    error.textContent = message;
    error.hidden = false;
    nameInput.focus();
  };
  nameInput.addEventListener('input', sync);
  nameInput.addEventListener('keydown', (e) => {
    // Enter commits from the NAME field only — the description is a
    // `<textarea>`, where Enter legitimately inserts a newline.
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
  });

  const handle = openDialogShell(app, opts.title, [
    h('div', { class: 'fm-dialog-body' },
      h('label', { class: 'fm-dialog-label', for: nameId }, opts.nameLabel),
      nameInput,
      h('label', { class: 'fm-dialog-label', for: descriptionId }, opts.descriptionLabel),
      descInput,
      note,
      error),
    h('div', { class: 'fm-dialog-actions' }, cancel, confirm),
  ], {
    returnFocusTo: opts.returnFocusTo,
    onClose: () => { closed = true; opts.onClose?.(); },
  });
  sync();
  setTimeout(() => { nameInput.focus(); nameInput.select(); });
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
