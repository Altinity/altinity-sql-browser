// #335: the generic anchored-dialog chrome, extracted from
// `multi-select-field.ts`'s `openPopover()` so a SECOND consumer (the
// time-range popover, a later wave) reuses it instead of copying it — the
// CLAUDE.md rule-5 "extract a shared primitive at the second consumer"
// precedent (`EditorPort`/`GraphSurface`/`Drawer`). It owns ONLY the generic
// modal-popover chrome; everything content-specific stays with the caller.
//
// OWNS:
//  - a fresh overlay + panel mounted on open, torn down completely on close
//    (menu.ts's lifecycle convention: never a hidden-but-resident node);
//  - the `dialog` role + `aria-modal="true"` + `aria-label` accessible name;
//  - a document-capture Escape that closes;
//  - a dialog-scoped Tab trap whose focusable set is RECOMPUTED on every Tab
//    press (never cached — the caller's content can hide/disable rows between
//    presses) and scoped to THIS dialog node so a stale, already-closed
//    popover's trap can never intercept a Tab meant for a different dialog;
//  - `fixedAnchor` placement under the trigger (optional right-edge clamp and
//    trigger-derived min-width);
//  - the `aria-expanded` true/false lifecycle on the trigger;
//  - teardown + focus return to the trigger, unless `skipFocus`.
//
// DOES NOT OWN: busy/loading state, live regions, any content semantics, the
// double-open guard (the caller keeps its own handle ref and decides whether
// to open a second one), or commit ordering.
//
// COMMIT ORDERING (the #364 / #189 merge-gate rule — consumers MUST follow it):
// call `close()` BEFORE invoking any commit callback (e.g. an Apply handler's
// `onApply`). A commit typically routes into state that `publish()`es
// synchronously; a subscriber that rebuilds the surrounding UI can run inside
// that very call stack, and it must observe this popover as ALREADY closed
// (`isOpen()` false) — never mistake an ordinary commit for a force-cancelled
// outgoing popover. See `multi-select-field.ts`'s Apply handler.

import { h, fixedAnchor, attachBackdropClose } from './dom.js';
import type { FixedAnchorOptions } from './dom.js';

/** `openAnchoredDialog`'s options bag. */
export interface AnchoredDialogOptions {
  /** Injected document realm — element creation, capture listeners, the
   *  focus-trap's `activeElement` read, and the mount point all target this. */
  document: Document;
  /** Gets `aria-expanded` true/false and is the focus-return target on close. */
  trigger: HTMLElement;
  /** The dialog's accessible name (`aria-label`). */
  ariaLabel: string;
  /** Pre-built content, appended into the dialog. The primitive never inspects
   *  it beyond the Tab trap's `input, button` query. */
  content: HTMLElement;
  /** The dialog element's class (e.g. `'ms-popover'` | `'trf-popover'`). */
  dialogClassName: string;
  /** The overlay/backdrop element's class — defaults to `'ms-overlay'`. */
  overlayClassName?: string;
  /** When true, the dialog's `min-width` is floored at the trigger's width. */
  minWidthFromTrigger?: boolean;
  /** When true, the dialog's left inset is clamped so its measured width does
   *  not overflow the viewport's right edge (pure arithmetic in `fixedAnchor`;
   *  in a headless realm without a `defaultView` the viewport width reads 0). */
  clampToViewport?: boolean;
  /** Returns the element to focus once the dialog is mounted, or null for
   *  none. Called with the dialog node after placement. */
  initialFocus?: (dialog: HTMLElement) => HTMLElement | null;
  /** Fires after teardown + focus return, on EVERY dismissal path, exactly
   *  once (idempotent close never double-fires it). */
  onClose?: () => void;
}

/** `openAnchoredDialog`'s return value. */
export interface AnchoredDialogHandle {
  /** The mounted dialog node — the caller reaches its own content through it
   *  (e.g. to toggle a busy affordance) without the primitive owning that. */
  dialog: HTMLElement;
  /** Whether the dialog is still mounted (false once `close()` has run). */
  isOpen(): boolean;
  /** Tears the dialog down and returns focus to the trigger unless
   *  `skipFocus`. Idempotent — every dismissal path funnels here, and a second
   *  call is a harmless no-op that never re-fires `onClose`. */
  close(opts?: { skipFocus?: boolean }): void;
}

export function openAnchoredDialog(opts: AnchoredDialogOptions): AnchoredDialogHandle {
  const d = opts.document;
  const { trigger } = opts;

  const overlay = h('div', { class: opts.overlayClassName ?? 'ms-overlay' });
  const dialog = h('div', {
    class: opts.dialogClassName, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.ariaLabel,
  }, opts.content);

  let open = true;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  // Recomputed on every Tab press (never cached): the caller's content can
  // hide (search filter) or disable (busy) rows between presses. Scoped to
  // THIS dialog so a leaked, already-closed popover's trap can't reach another
  // open dialog's subtree.
  function focusableEls(): HTMLElement[] {
    return [...dialog.querySelectorAll<HTMLElement>('input, button')]
      .filter((el) => !el.closest('[hidden]') && !(el as HTMLInputElement | HTMLButtonElement).disabled);
  }
  const onTabTrap = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const items = focusableEls();
    if (items.length === 0) return; // nothing to trap — let the browser handle it
    const first = items[0];
    const last = items[items.length - 1];
    const activeEl = d.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (!activeEl || activeEl === first || !dialog.contains(activeEl)) { e.preventDefault(); last.focus(); }
    } else if (!activeEl || activeEl === last || !dialog.contains(activeEl)) {
      e.preventDefault(); first.focus();
    }
  };

  // The single teardown funnel. Idempotent: the `open` guard means teardown +
  // `onClose` run exactly once no matter how many dismissal paths reach it.
  function close(closeOpts: { skipFocus?: boolean } = {}): void {
    if (!open) return;
    open = false;
    d.removeEventListener('keydown', onKeyDown, true);
    dialog.removeEventListener('keydown', onTabTrap, true);
    detachBackdrop();
    overlay.remove();
    dialog.remove();
    trigger.setAttribute('aria-expanded', 'false');
    if (!closeOpts.skipFocus) trigger.focus();
    opts.onClose?.();
  }

  trigger.setAttribute('aria-expanded', 'true');
  d.body.appendChild(overlay);
  d.body.appendChild(dialog);
  const detachBackdrop = attachBackdropClose(overlay, () => close());
  d.addEventListener('keydown', onKeyDown, true);
  dialog.addEventListener('keydown', onTabTrap, true);

  const rect = trigger.getBoundingClientRect();
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  dialog.style.position = 'fixed';
  const anchorOpts: FixedAnchorOptions = {};
  if (opts.clampToViewport) {
    const view = d.defaultView;
    anchorOpts.viewportW = view ? view.innerWidth : 0;
    anchorOpts.panelW = dialog.getBoundingClientRect().width;
  }
  // Both the plain and the clamped paths left-align (the clamp only lowers the
  // left inset), so the result is always `{ top, left }`.
  const pos = fixedAnchor(rect, anchorOpts) as { top: number; left: number };
  dialog.style.top = pos.top + 'px';
  dialog.style.left = pos.left + 'px';
  if (opts.minWidthFromTrigger) dialog.style.minWidth = rect.width + 'px';

  const focusTarget = opts.initialFocus?.(dialog);
  if (focusTarget) focusTarget.focus();

  return { dialog, isOpen: () => open, close };
}
