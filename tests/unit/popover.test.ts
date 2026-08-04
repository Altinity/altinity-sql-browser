import { describe, it, expect, vi, afterEach } from 'vitest';
import { openAnchoredDialog, createAnchoredPopovers } from '../../src/ui/popover.js';
import type { AnchoredDialogOptions, AnchoredPopoverDeps, AnchoredPopoverRefKey } from '../../src/ui/popover.js';
import { h } from '../../src/ui/dom.js';

afterEach(() => document.body.replaceChildren());

const key = (target: EventTarget, k: string, shiftKey = false): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

// A trigger already mounted in the body, plus a content element carrying a
// couple of focusable rows (input + button) — the primitive's Tab trap keys
// off `input, button`.
function setup(overrides: Partial<AnchoredDialogOptions> = {}): {
  trigger: HTMLButtonElement;
  content: HTMLElement;
  input: HTMLInputElement;
  button: HTMLButtonElement;
  open: () => ReturnType<typeof openAnchoredDialog>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const trigger = h('button', { type: 'button', 'aria-expanded': 'false' }) as HTMLButtonElement;
  document.body.appendChild(trigger);
  const input = h('input', { type: 'text', class: 'pv-input' }) as HTMLInputElement;
  const button = h('button', { type: 'button', class: 'pv-button' }) as HTMLButtonElement;
  const content = h('div', { style: { display: 'contents' } }, input, button);
  const onClose = vi.fn();
  const open = (): ReturnType<typeof openAnchoredDialog> =>
    openAnchoredDialog({
      document,
      trigger,
      ariaLabel: 'Test dialog',
      content,
      dialogClassName: 'pv-popover',
      onClose,
      ...overrides,
    });
  return { trigger, content, input, button, open, onClose };
}

const dialogEl = (): HTMLElement | null => document.body.querySelector('.pv-popover');
const overlayEl = (cls = '.popover-overlay'): HTMLElement | null => document.body.querySelector(cls);

describe('openAnchoredDialog — mount + ARIA', () => {
  it('mounts an overlay and a dialog with role/aria-modal/aria-label, and appends the content', () => {
    const { content, open } = setup();
    const handle = open();
    const dialog = dialogEl()!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Test dialog');
    expect(dialog.contains(content)).toBe(true);
    expect(overlayEl()).not.toBeNull(); // default overlay class
    expect(handle.dialog).toBe(dialog);
    expect(handle.isOpen()).toBe(true);
  });

  it('honors a custom overlayClassName', () => {
    const { open } = setup({ overlayClassName: 'trf-overlay' });
    open();
    expect(overlayEl('.popover-overlay')).toBeNull();
    expect(overlayEl('.trf-overlay')).not.toBeNull();
  });

  it('sets aria-expanded true on open and false on close', () => {
    const { trigger, open } = setup();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const handle = open();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    handle.close();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('openAnchoredDialog — placement', () => {
  it('positions the dialog under the trigger rect via fixedAnchor (fixed, min-floored in a zero-rect realm)', () => {
    const { open } = setup();
    open();
    const dialog = dialogEl()!;
    expect(dialog.style.position).toBe('fixed');
    // happy-dom rects are all-zero → fixedAnchor floors to top=6 (default gap),
    // left=8 (default min).
    expect(dialog.style.top).toBe('6px');
    expect(dialog.style.left).toBe('8px');
  });

  it('minWidthFromTrigger true sets a min-width from the trigger rect; false/omit leaves it unset', () => {
    const withMin = setup({ minWidthFromTrigger: true });
    withMin.open();
    expect(dialogEl()!.style.minWidth).toBe('0px'); // trigger rect width is 0 in happy-dom
    document.body.replaceChildren();

    const without = setup();
    without.open();
    expect(dialogEl()!.style.minWidth).toBe('');
  });

  it('overlay is fixed and covers the viewport', () => {
    const { open } = setup();
    open();
    const overlay = overlayEl()!;
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.inset).toBe('0');
  });

  it('clampToViewport left-aligns via the fixedAnchor clamp path (reads defaultView width)', () => {
    const { open } = setup({ clampToViewport: true });
    open();
    const dialog = dialogEl()!;
    // Clamp path always yields a left inset (never a right one).
    expect(dialog.style.left).not.toBe('');
    expect(dialog.style.right).toBe('');
  });

  it('clampToViewport tolerates a realm without a defaultView (viewport width reads 0)', () => {
    const doc = document.implementation.createHTMLDocument('');
    const trigger = doc.createElement('button');
    doc.body.appendChild(trigger);
    const content = doc.createElement('div');
    const handle = openAnchoredDialog({
      document: doc, trigger, ariaLabel: 'x', content,
      dialogClassName: 'pv-popover', clampToViewport: true,
    });
    const dialog = doc.querySelector('.pv-popover') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.style.left).not.toBe('');
    handle.close();
  });
});

describe('openAnchoredDialog — dismissal paths', () => {
  it('Escape closes and returns focus to the trigger; onClose fires', () => {
    const { trigger, open, onClose } = setup();
    const handle = open();
    key(dialogEl()!, 'Escape');
    expect(handle.isOpen()).toBe(false);
    expect(dialogEl()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a non-Escape key does not close', () => {
    const { open } = setup();
    const handle = open();
    key(dialogEl()!, 'a');
    expect(handle.isOpen()).toBe(true);
  });

  it('a backdrop mousedown+click closes; onClose fires', () => {
    const { open, onClose } = setup();
    const handle = open();
    const overlay = overlayEl()!;
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handle.isOpen()).toBe(false);
    expect(dialogEl()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent — a second call neither throws nor re-fires onClose', () => {
    const { open, onClose } = setup();
    const handle = open();
    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(handle.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close({ skipFocus: true }) tears down but leaves the trigger unfocused', () => {
    const { trigger, open } = setup();
    const handle = open();
    // Move focus off the trigger first so a skipped focus-return is observable.
    const input = document.querySelector('.pv-input') as HTMLInputElement;
    input.focus();
    handle.close({ skipFocus: true });
    expect(dialogEl()).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });
});

describe('openAnchoredDialog — Tab focus trap (#439: primitive owns every transition)', () => {
  const tab = (target: EventTarget, shiftKey = false): boolean => key(target, 'Tab', shiftKey);

  // A three-row dialog (a, b, c) is enough to exercise first/middle/last for
  // both directions without depending on `setup()`'s two-row fixture.
  function setupThree(): { trigger: HTMLButtonElement; a: HTMLInputElement; b: HTMLButtonElement; c: HTMLButtonElement } {
    const trigger = h('button', {}) as HTMLButtonElement;
    document.body.appendChild(trigger);
    const a = h('input', { class: 'r-a' }) as HTMLInputElement;
    const b = h('button', { class: 'r-b' }) as HTMLButtonElement;
    const c = h('button', { class: 'r-c' }) as HTMLButtonElement;
    const content = h('div', { style: { display: 'contents' } }, a, b, c);
    openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
    return { trigger, a, b, c };
  }

  describe('forward traversal', () => {
    it('Tab from the first element focuses the second', () => {
      const { a, b } = setupThree();
      a.focus();
      tab(dialogEl()!);
      expect(document.activeElement).toBe(b);
    });

    it('Tab from a middle element focuses the next element', () => {
      const { b, c } = setupThree();
      b.focus();
      tab(dialogEl()!);
      expect(document.activeElement).toBe(c);
    });

    it('Tab from the last element wraps to the first', () => {
      const { a, c } = setupThree();
      c.focus();
      tab(dialogEl()!);
      expect(document.activeElement).toBe(a);
    });

    it('preventDefault()s every non-empty forward traversal', () => {
      const { a } = setupThree();
      a.focus();
      const handled = tab(dialogEl()!);
      expect(handled).toBe(false); // preventDefault-ed
    });
  });

  describe('backward traversal', () => {
    it('Shift+Tab from the last element focuses the previous element', () => {
      const { b, c } = setupThree();
      c.focus();
      tab(dialogEl()!, true);
      expect(document.activeElement).toBe(b);
    });

    it('Shift+Tab from a middle element focuses the previous element', () => {
      const { a, b } = setupThree();
      b.focus();
      tab(dialogEl()!, true);
      expect(document.activeElement).toBe(a);
    });

    it('Shift+Tab from the first element wraps to the last', () => {
      const { a, c } = setupThree();
      a.focus();
      tab(dialogEl()!, true);
      expect(document.activeElement).toBe(c);
    });

    it('preventDefault()s every non-empty backward traversal', () => {
      const { c } = setupThree();
      c.focus();
      const handled = tab(dialogEl()!, true);
      expect(handled).toBe(false); // preventDefault-ed
    });
  });

  describe('dynamic eligibility', () => {
    it('disabling a middle element is reflected on the very next press', () => {
      const { a, b, c } = setupThree();
      b.disabled = true; // eligible set is now [a, c]
      a.focus();
      tab(dialogEl()!);
      expect(document.activeElement).toBe(c);
    });

    it('disabling the last element moves the wrap target', () => {
      const { a, b, c } = setupThree();
      c.disabled = true; // eligible set is now [a, b]
      b.focus();
      tab(dialogEl()!);
      expect(document.activeElement).toBe(a);
    });

    it('an element inside a hidden ancestor is excluded', () => {
      const trigger = h('button', {}) as HTMLButtonElement;
      document.body.appendChild(trigger);
      const a = h('input', { class: 'r-a' }) as HTMLInputElement;
      const wrap = h('div', { hidden: true }, h('button', { class: 'r-b' }));
      const c = h('button', { class: 'r-c' }) as HTMLButtonElement;
      const content = h('div', { style: { display: 'contents' } }, a, wrap, c);
      openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
      a.focus();
      tab(dialogEl()!);
      expect(document.activeElement).toBe(c);
    });

    it('re-enabling a disabled element makes it eligible again without reopening the dialog', () => {
      const { a, b, c } = setupThree();
      b.disabled = true;
      a.focus();
      tab(dialogEl()!); // skips disabled b → c
      expect(document.activeElement).toBe(c);
      b.disabled = false;
      tab(dialogEl()!); // c → wraps to a
      expect(document.activeElement).toBe(a);
      tab(dialogEl()!); // a → b, now eligible again
      expect(document.activeElement).toBe(b);
    });

    it('a focused element disabled before the next Tab is treated as out of the set: Tab chooses the first', () => {
      const { a, b } = setupThree();
      b.focus();
      b.disabled = true;
      tab(dialogEl()!);
      expect(document.activeElement).toBe(a);
    });

    it('a focused element disabled before the next Shift+Tab is treated as out of the set: Shift+Tab chooses the last', () => {
      const { b, c } = setupThree();
      b.focus();
      b.disabled = true;
      tab(dialogEl()!, true);
      expect(document.activeElement).toBe(c);
    });

    it('a focused element removed before the next Tab is treated as out of the set: Tab chooses the first', () => {
      const { a, b } = setupThree();
      b.focus();
      b.remove();
      tab(dialogEl()!);
      expect(document.activeElement).toBe(a);
    });
  });

  describe('edge cases', () => {
    it('a single eligible element retains focus on Tab', () => {
      const trigger = h('button', {}) as HTMLButtonElement;
      document.body.appendChild(trigger);
      const only = h('button', { class: 'only' }) as HTMLButtonElement;
      const content = h('div', { style: { display: 'contents' } }, only);
      openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
      only.focus();
      tab(dialogEl()!);
      expect(document.activeElement).toBe(only);
    });

    it('a single eligible element retains focus on Shift+Tab', () => {
      const trigger = h('button', {}) as HTMLButtonElement;
      document.body.appendChild(trigger);
      const only = h('button', { class: 'only' }) as HTMLButtonElement;
      const content = h('div', { style: { display: 'contents' } }, only);
      openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
      only.focus();
      tab(dialogEl()!, true);
      expect(document.activeElement).toBe(only);
    });

    it('Tab with no focusable content is a no-op (empty-set guard)', () => {
      const trigger = h('button', {}) as HTMLButtonElement;
      document.body.appendChild(trigger);
      const content = h('div', {}, h('span', {}, 'no focusables here'));
      openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
      const handled = tab(dialogEl()!);
      expect(handled).toBe(true); // untrapped — browser handles it
    });

    it('a non-Tab key inside the dialog is ignored by the trap', () => {
      const { open, button } = setup();
      open();
      button.focus();
      const handled = key(dialogEl()!, 'ArrowDown');
      expect(handled).toBe(true); // not preventDefault-ed
      expect(document.activeElement).toBe(button); // focus unchanged
    });

    it('the listener is scoped to the live dialog and removed on close', () => {
      const { open, input } = setup();
      const handle = open();
      handle.close();
      // Re-append the (now-detached) dialog-scoped input to the body and Tab
      // on it directly — with the listener removed, nothing intercepts it, so
      // the key event is left unhandled and focus is untouched.
      document.body.appendChild(input);
      input.focus();
      const handled = tab(input);
      expect(handled).toBe(true); // no trap left listening
      expect(document.activeElement).toBe(input); // no trap side effect moved focus
    });
  });
});

describe('openAnchoredDialog — reclaimFocus (#439)', () => {
  // A caller that disables the currently-focused control (e.g. a busy-state
  // toggle) natively evicts focus past the dialog-scoped Tab trap's reach —
  // the trap only runs on an event whose target is inside `dialog`, and a
  // disabled element can no longer be that target. `reclaimFocus()` is the
  // escape hatch: called right after the mutation, it recovers focus onto
  // the first still-eligible element.

  it('is a no-op when the active element is still eligible', () => {
    const { open, input, button } = setup();
    const handle = open();
    button.focus();
    handle.reclaimFocus();
    expect(document.activeElement).toBe(button);
  });

  it('moves focus to the first eligible element when the active element was just disabled', () => {
    const trigger = h('button', {}) as HTMLButtonElement;
    document.body.appendChild(trigger);
    const a = h('input', { class: 'r-a' }) as HTMLInputElement;
    const b = h('button', { class: 'r-b' }) as HTMLButtonElement;
    const c = h('button', { class: 'r-c' }) as HTMLButtonElement;
    const content = h('div', { style: { display: 'contents' } }, a, b, c);
    const handle = openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
    b.focus();
    b.disabled = true; // the mutation a busy-state toggle performs
    handle.reclaimFocus();
    expect(document.activeElement).toBe(a); // first still-eligible row
  });

  it('recovers focus that a caller mutation already moved outside the dialog entirely', () => {
    const { trigger, open, input } = setup();
    const handle = open();
    trigger.focus(); // simulates the native evict-to-outside-the-dialog case
    handle.reclaimFocus();
    expect(document.activeElement).toBe(input); // first eligible row inside the dialog
  });

  it('is a no-op (safe) when nothing in the dialog is eligible', () => {
    const trigger = h('button', {}) as HTMLButtonElement;
    document.body.appendChild(trigger);
    const only = h('button', { class: 'only', disabled: true }) as HTMLButtonElement;
    const content = h('div', { style: { display: 'contents' } }, only);
    const handle = openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
    expect(() => handle.reclaimFocus()).not.toThrow();
  });
});

describe('openAnchoredDialog — initialFocus', () => {
  it('focuses the element the callback returns', () => {
    const { open, input } = setup({ initialFocus: (dialog) => dialog.querySelector('.pv-input') });
    open();
    expect(document.activeElement).toBe(input);
  });

  it('omitting initialFocus (or returning null) leaves focus where it was', () => {
    const { trigger, open } = setup({ initialFocus: () => null });
    trigger.focus();
    open();
    expect(document.activeElement).toBe(trigger);
  });
});

// ── `createAnchoredPopovers` (#588 W2) ──────────────────────────────────────
// A different primitive from `openAnchoredDialog` above: a light, non-modal
// anchored popover (no overlay, no Tab trap) used for the Save popover and
// the user menu. Extracted verbatim out of app.ts's `anchoredPopover` +
// module-scoped closers Set — see popover.ts's own header comment on this
// section for what's deliberately preserved (the I-21 stale-close clobber).

/** A tiny keyboard-owner stack modeling the REAL `app.acquireKeyboardOwner`
 *  contract (app.ts): each acquisition's own `release` is idempotent (a
 *  `released` flag guards a second call from popping the stack twice). This
 *  is the "real half" of I-21 ("each close releases the keyboard owner
 *  exactly once") — `createAnchoredPopovers` itself calls `releaseKeyboard()`
 *  unconditionally on every `close()`, so the exactly-once guarantee lives
 *  in the caller-supplied release closure, exactly as it does in app.ts. */
function makeKeyboardOwnerStack(): {
  acquireKeyboardOwner: AnchoredPopoverDeps['acquireKeyboardOwner'];
  owners: { kind: string }[];
} {
  const owners: { kind: string }[] = [];
  const acquireKeyboardOwner: AnchoredPopoverDeps['acquireKeyboardOwner'] = (kind) => {
    const owner = { kind };
    owners.push(owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const index = owners.indexOf(owner);
      if (index >= 0) owners.splice(index, 1);
    };
  };
  return { acquireKeyboardOwner, owners };
}

function setupPopovers(over: Partial<AnchoredPopoverDeps> = {}): {
  popovers: ReturnType<typeof createAnchoredPopovers>;
  refs: Partial<Record<AnchoredPopoverRefKey, HTMLElement>>;
  owners: { kind: string }[];
} {
  const refs: Partial<Record<AnchoredPopoverRefKey, HTMLElement>> = {};
  const { acquireKeyboardOwner, owners } = makeKeyboardOwnerStack();
  const popovers = createAnchoredPopovers({
    document,
    acquireKeyboardOwner,
    isMobile: () => false,
    viewportWidth: () => 1024,
    getRef: (key) => refs[key],
    setRef: (key, node) => { refs[key] = node; },
    ...over,
  });
  return { popovers, refs, owners };
}

const anchorEl = (): HTMLElement => document.body.appendChild(h('button', {}));

describe('createAnchoredPopovers — open/close', () => {
  it('mounts the node, records it at the refKey, and acquires the keyboard owner', () => {
    const { popovers, refs, owners } = setupPopovers();
    const node = h('div', { class: 'my-pop' });
    const anchor = anchorEl();
    popovers.open(node, anchor, 'savePopover');
    expect(document.body.contains(node)).toBe(true);
    expect(refs.savePopover).toBe(node);
    expect(owners).toEqual([{ kind: 'popover' }]);
    expect(node.style.position).toBe('fixed');
  });

  it('close() unmounts the node, clears the ref, and releases the keyboard owner', () => {
    const { popovers, refs, owners } = setupPopovers();
    const node = h('div', {});
    const { close } = popovers.open(node, anchorEl(), 'savePopover');
    close();
    expect(document.body.contains(node)).toBe(false);
    expect(refs.savePopover).toBeUndefined();
    expect(owners).toEqual([]);
  });

  it('right-aligns under the anchor on desktop; centers horizontally on mobile', () => {
    const desktop = setupPopovers({ isMobile: () => false });
    const nodeDesktop = h('div', {});
    desktop.popovers.open(nodeDesktop, anchorEl(), 'savePopover');
    expect(nodeDesktop.style.right).not.toBe('');
    expect(nodeDesktop.style.left).toBe('');

    const mobile = setupPopovers({ isMobile: () => true });
    const nodeMobile = h('div', {});
    mobile.popovers.open(nodeMobile, anchorEl(), 'savePopover');
    expect(nodeMobile.style.left).toBe('50%');
    expect(nodeMobile.style.transform).toBe('translateX(-50%)');
  });

  it('Escape closes the popover', () => {
    const { popovers, refs } = setupPopovers();
    const node = h('div', {});
    popovers.open(node, anchorEl(), 'savePopover');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.body.contains(node)).toBe(false);
    expect(refs.savePopover).toBeUndefined();
  });

  it('a mousedown outside both the popover and its anchor closes it', () => {
    const { popovers } = setupPopovers();
    const node = h('div', {});
    const anchor = anchorEl();
    popovers.open(node, anchor, 'savePopover');
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.body.contains(node)).toBe(false);
  });

  it('a mousedown inside the popover node, or on its anchor, does not close it', () => {
    const { popovers } = setupPopovers();
    const node = h('div', {}, h('span', { class: 'inner' }, 'x'));
    const anchor = anchorEl();
    popovers.open(node, anchor, 'savePopover');
    node.querySelector('.inner')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.body.contains(node)).toBe(true);
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.body.contains(node)).toBe(true);
  });

  it('closeAll() closes every currently-open popover, across different refKeys', () => {
    const { popovers, refs } = setupPopovers();
    const nodeA = h('div', {});
    const nodeB = h('div', {});
    popovers.open(nodeA, anchorEl(), 'savePopover');
    popovers.open(nodeB, anchorEl(), 'userMenu');
    popovers.closeAll();
    expect(document.body.contains(nodeA)).toBe(false);
    expect(document.body.contains(nodeB)).toBe(false);
    expect(refs.savePopover).toBeUndefined();
    expect(refs.userMenu).toBeUndefined();
    expect(() => popovers.closeAll()).not.toThrow(); // nothing left to close
  });

  // I-21's "real" half: `createAnchoredPopovers` itself calls
  // `releaseKeyboard()` unconditionally on every `close()` — the
  // exactly-once guarantee depends on the CALLER's release closure being
  // idempotent (as the real `app.acquireKeyboardOwner` is). Sabotage: if
  // that release closure were NOT idempotent, a stale double `close()` would
  // pop the keyboard-owner stack twice, catching this test.
  it('a stale double close() cannot double-release the keyboard owner when the caller\'s release is idempotent', () => {
    const { popovers, owners } = setupPopovers();
    const node = h('div', {});
    const { close } = popovers.open(node, anchorEl(), 'savePopover');
    expect(owners).toHaveLength(1);
    close();
    expect(owners).toHaveLength(0);
    close(); // stale second call
    expect(owners).toHaveLength(0); // still 0 — release() itself no-oped
  });

  // I-21 (documented defect — phase 4 plan §9-2, NOT fixed here): `close()`
  // removes WHATEVER node currently occupies `refKey`, without checking that
  // it is the node THIS `close()` itself opened. A caller retaining a stale
  // `close()` handle across a second `open()` on the same `refKey` clobbers
  // the newer popover instead of being a safe no-op.
  it('I-21: a stale close() from an earlier popover clobbers a newer popover sharing the same refKey (current, unfixed behavior)', () => {
    const { popovers, refs } = setupPopovers();
    const anchor = anchorEl();
    const nodeA = h('div', { class: 'pop-a' });
    const nodeB = h('div', { class: 'pop-b' });
    const { close: closeA } = popovers.open(nodeA, anchor, 'savePopover');
    // B opens on the SAME refKey without A ever closing — the real Save
    // popover/user-menu callers guard this with their own `if (app.dom[refKey])
    // return;` check before opening, but `createAnchoredPopovers` itself does
    // not enforce it.
    popovers.open(nodeB, anchor, 'savePopover');
    expect(document.body.contains(nodeA)).toBe(true);
    expect(document.body.contains(nodeB)).toBe(true);
    expect(refs.savePopover).toBe(nodeB);

    closeA(); // A's stale handle

    // Documented defect: closeA() clobbers B (whatever currently occupies the
    // ref), NOT A's own node — A's node is left mounted and orphaned.
    expect(document.body.contains(nodeB)).toBe(false);
    expect(document.body.contains(nodeA)).toBe(true);
    expect(refs.savePopover).toBeUndefined();
  });
});
