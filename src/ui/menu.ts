// A shared, data-driven dropdown-menu primitive extracted from the previously
// duplicated Workbench (file-menu.ts) and Dashboard (dashboard.ts) File-menu
// builders (#331 area 2). `openMenu(opts)` owns the shared STRUCTURE and
// INTERACTION GRAMMAR — `.fm-item`/`.fm-section`/`.fm-sep` rows, `.fm-overlay`
// outside-click dismiss, Escape + focus-restore-to-trigger, ArrowUp/ArrowDown
// roving focus across the focusable rows, autofocus of the first focusable
// row on open, `aria-haspopup`/`aria-expanded` on the trigger, and
// `fixedAnchor` placement under it — while each caller supplies its own
// resource-specific CONTENTS via the `MenuRow[]` data model (icons, labels,
// meta text, sections, separators, and arbitrary `custom` rows for anything
// that doesn't fit the item shape, e.g. the Workbench's variable-history
// toggle row or its `.fm-count` footer).
//
// Re-calling `openMenu` on a trigger that already has an open menu is a
// no-op — it returns the SAME handle rather than stacking a second menu. A
// caller that wants an explicit open/close TOGGLE on its trigger button (the
// Dashboard File button) tracks that itself via the returned handle, calling
// `handle.close()` directly rather than a second `openMenu` — `openMenu`
// itself only ever opens (or returns the existing open handle).
//
// Pure-DOM, no globals: the `Document` and the trigger element are both
// passed in (matching every other render module's injected-`document`
// convention), so this is fully unit-testable under happy-dom.

import { h, fixedAnchor } from './dom.js';
import type { KeyboardOwner } from './app.types.js';

/** One row of a dropdown menu.
 *  - `item` — an actionable `.fm-item` row: icon + label + optional meta text
 *    (e.g. a file extension), invoking `onClick` after the menu closes.
 *    `extraClass` adds a caller-specific marker class alongside `.fm-item`
 *    (e.g. `dash-fm-item`).
 *  - `section` — a `.fm-section` heading.
 *  - `sep` — a `.fm-sep` divider.
 *  - `custom` — an arbitrary caller-built node spliced in as-is. `focusable:
 *    true` makes it a stop in the ArrowUp/ArrowDown roving-focus order — the
 *    focus target is the row's own first focusable descendant (an `<input>`/
 *    `<button>`/etc.), or the node itself when it can take focus directly. */
export type MenuRow =
  | { kind: 'item'; leading?: Node; icon?: Node; label: string; trailing?: Node; meta?: string | null; onClick: () => void; extraClass?: string }
  | { kind: 'section'; label: string }
  | { kind: 'sep' }
  | { kind: 'custom'; node: HTMLElement; focusable?: boolean };

export interface MenuOptions {
  /** The document to build/mount into — never the ambient global. */
  document: Document;
  /** The button this menu is anchored under; also the `aria-expanded`/focus-
   *  restore owner. A second `openMenu` call on the SAME trigger while its
   *  menu is still open returns the existing handle unchanged. */
  trigger: HTMLElement;
  rows: readonly MenuRow[];
  /** Extra class(es) appended to the mounted `.file-menu` element (e.g.
   *  `dash-file-menu` for the Dashboard's width override). */
  menuClass?: string;
  /** Called once the menu is fully torn down, however it closed (Escape,
   *  overlay click, an item's own click, or an explicit `handle.close()`) —
   *  lets the caller clear its own open/closed bookkeeping. */
  onClose?: () => void;
  onKeyboardOwnerChange?: (owner: KeyboardOwner | null) => void;
}

export interface MenuHandle {
  /** The mounted `.file-menu` element — a caller needing to splice in extra,
   *  non-row DOM (the Workbench's hidden file `<input>` pickers) appends to
   *  this directly, after `openMenu` returns. */
  readonly el: HTMLElement;
  close(): void;
}

// One open menu per trigger at a time — keyed by the live trigger element. A
// WeakMap so a since-discarded trigger (e.g. a torn-down test DOM) doesn't
// keep a stale handle reachable.
const openByTrigger = new WeakMap<HTMLElement, MenuHandle>();
const openByDocument = new WeakMap<Document, Set<() => void>>();

/** Close every body-mounted menu owned by `doc` (surface-navigation teardown). */
export function closeOpenMenus(doc: Document): void {
  for (const close of [...(openByDocument.get(doc) ?? [])]) close();
}

// The focus target for a `custom` row: its own first focusable descendant, or
// the node itself when it already matches a focusable selector directly.
const focusTargetOf = (node: HTMLElement): HTMLElement =>
  node.matches('input,button,select,textarea,[tabindex]')
    ? node
    : node.querySelector<HTMLElement>('input,button,select,textarea,[tabindex]') || node;

/** Open a dropdown menu built from `rows`, anchored under `trigger`. A second
 *  call on a trigger that already has one open returns the SAME handle
 *  without rebuilding (no second menu is ever stacked). */
export function openMenu(opts: MenuOptions): MenuHandle {
  const existing = openByTrigger.get(opts.trigger);
  if (existing) return existing;

  const { document: doc, trigger, rows, menuClass, onClose } = opts;
  const focusable: HTMLElement[] = [];

  const buildRow = (row: MenuRow): Node => {
    if (row.kind === 'section') return h('div', { class: 'fm-section' }, row.label);
    if (row.kind === 'sep') return h('div', { class: 'fm-sep' });
    if (row.kind === 'custom') {
      if (row.focusable) focusable.push(focusTargetOf(row.node));
      return row.node;
    }
    const btn = h('button', {
      class: row.extraClass ? `fm-item ${row.extraClass}` : 'fm-item',
      role: 'menuitem',
      onclick: () => { close(); row.onClick(); },
    },
      row.leading ? h('span', { class: 'fm-leading' }, row.leading) : null,
      row.icon ? h('span', { class: 'fm-icon' }, row.icon) : null,
      h('span', { class: 'fm-label' }, row.label),
      row.trailing ? h('span', { class: 'fm-trailing' }, row.trailing) : null,
      row.meta ? h('span', { class: 'fm-meta' }, row.meta) : null);
    focusable.push(btn);
    return btn;
  };

  const menu = h('div', { class: menuClass ? `file-menu ${menuClass}` : 'file-menu', role: 'menu' },
    ...rows.map(buildRow));
  const overlay = h('div', { class: 'fm-overlay', onclick: () => close() });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!focusable.length) return;
    e.preventDefault();
    const at = focusable.indexOf(doc.activeElement as HTMLElement);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next = (at + delta + focusable.length) % focusable.length;
    focusable[next]?.focus();
  };

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    openByTrigger.delete(trigger);
    const documentClosers = openByDocument.get(doc);
    documentClosers?.delete(close);
    if (documentClosers?.size === 0) openByDocument.delete(doc);
    doc.removeEventListener('keydown', onKey, true);
    menu.remove();
    overlay.remove();
    trigger.setAttribute('aria-expanded', 'false');
    onClose?.();
    opts.onKeyboardOwnerChange?.(null);
  }

  trigger.setAttribute('aria-haspopup', 'menu');
  opts.onKeyboardOwnerChange?.({ kind: 'menu' });
  trigger.setAttribute('aria-expanded', 'true');
  doc.body.appendChild(overlay);
  doc.body.appendChild(menu);
  const r = trigger.getBoundingClientRect();
  // fixedAnchor's return type is a `{top,left}` / `{top,right}` union (the
  // right-align branch only fires when a `viewportW` option is passed) — this
  // call site never passes one, so it's always the `{top,left}` shape.
  const a = fixedAnchor(r) as { top: number; left: number };
  menu.style.position = 'fixed';
  menu.style.top = a.top + 'px';
  menu.style.left = a.left + 'px';
  doc.addEventListener('keydown', onKey, true);
  if (focusable.length) setTimeout(() => focusable[0].focus());

  const handle: MenuHandle = { el: menu, close };
  openByTrigger.set(trigger, handle);
  let documentClosers = openByDocument.get(doc);
  if (!documentClosers) {
    documentClosers = new Set();
    openByDocument.set(doc, documentClosers);
  }
  documentClosers.add(close);
  return handle;
}
