// The destructive-confirmation menu, as one primitive (CLAUDE.md rule 5).
//
// Three surfaces ask "are you sure?" the same way, and until now each spelled it
// out itself: the Dashboards tree's delete controls (`dashboard-tree.ts`, #494),
// the tab strip's close-a-dirty-draft guard (`tabs.ts`, #466 — whose own comment
// says it mirrors the tree's), and now a Dashboard tile head's Remove row. Three
// copies of a shape is where a decision starts drifting, and one of the
// decisions here is INVISIBLE in the row order:
//
//   - the destructive row reads FIRST, matching this app's visual convention
//     (the action on top, Cancel below it), but
//   - Cancel carries `autofocus: true`, so a keyboard user who opens the
//     confirmation and presses Enter out of momentum lands on Cancel rather than
//     on the row that destroys something (#501).
//
// A fourth caller writing the rows by hand gets the order right and the focus
// wrong, silently. That is the whole argument for this module.
//
// The three CLASS names stay caller-supplied rather than being shared as one
// `.fm-confirm*` set. `styles.css` states per-consumer styling as this area's
// convention, each caller's width and prose differ, and renaming them would
// churn dozens of test selectors for no behaviour change — so the STRUCTURE and
// the focus grammar are what get shared, not the skin.
//
// Pure-DOM with an injected `document`, exactly like `menu.ts` underneath it.

import { openMenu } from './menu.js';
import type { MenuHandle } from './menu.js';
import type { KeyboardOwner } from './app.types.js';

export interface ConfirmMenuOptions {
  /** The document to build/mount into — never the ambient global. */
  document: Document;
  /** The control that asked; also the `aria-expanded` and focus-restore owner. */
  trigger: HTMLElement;
  /** The whole question, already naming the resources it is about. Rendered as
   *  the menu's `.fm-section` heading, so it may wrap to several lines. */
  question: string;
  /** The go-ahead label. Never "OK": the question above is full of names, and
   *  a generic affirmative next to it is where an accidental click happens. */
  confirmLabel: string;
  /** Class on the mounted popup (e.g. `dash-tree-confirm`). */
  menuClass: string;
  /** Class on the destructive row (e.g. `dash-tree-confirm-go`). */
  goClass: string;
  /** Class on the Cancel row (e.g. `dash-tree-confirm-cancel`). */
  cancelClass: string;
  /** Accessible name for the popup's `role="menu"`. */
  ariaLabel?: string;
  onConfirm(): void;
  /**
   * Where focus goes when the confirmation closes, resolved lazily on EVERY
   * close — Cancel, Escape, an outside click, and the destructive row alike.
   *
   * A resolver rather than an element on purpose: the confirmation is body-mounted
   * and can sit open across an unrelated repaint, so the control that opened it
   * may have been replaced by then — and `focus()` on a detached or `display: none`
   * node is a silent no-op in a real browser. Returning `null` means "leave focus
   * alone", which is what `openMenu` already does by itself.
   *
   * Not conditional on cancelling, and it need not be: `menu.ts` closes the menu
   * BEFORE running a row's `onClick`, so on the destructive path this restore
   * lands first and `onConfirm` — which owns where focus goes once the thing the
   * user was standing on is gone — simply moves it afterwards. Trying to suppress
   * it would mean reading a flag the row cannot have set yet.
   */
  returnFocusTo?: () => HTMLElement | null;
  onKeyboardOwnerChange?: (owner: KeyboardOwner | null) => void;
}

/** Ask before destroying something, anchored on the control that asked. */
export function openConfirmMenu(opts: ConfirmMenuOptions): MenuHandle {
  return openMenu({
    document: opts.document,
    trigger: opts.trigger,
    menuClass: opts.menuClass,
    ...(opts.ariaLabel ? { ariaLabel: opts.ariaLabel } : {}),
    onKeyboardOwnerChange: opts.onKeyboardOwnerChange,
    onClose: () => { opts.returnFocusTo?.()?.focus(); },
    rows: [
      { kind: 'section', label: opts.question },
      {
        kind: 'item',
        label: opts.confirmLabel,
        extraClass: opts.goClass,
        onClick: opts.onConfirm,
      },
      {
        kind: 'item', label: 'Cancel', extraClass: opts.cancelClass, autofocus: true,
        onClick: () => {},
      },
    ],
  });
}
