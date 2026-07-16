// Accessible type-to-filter combobox primitive (#174 §1), first built for
// #169's relative-time presets — #171 (recents) and #172 (enum values) reuse
// it unchanged, and #160's curated single-select composes it. Wraps a plain
// text `<input>` (the field NEVER becomes read-only/select-only — free text
// keeps working) with a popover `<ul role="listbox">`: full ARIA combobox
// contract, keyboard nav, IME-composition safety, mousedown-before-blur
// commit. Options are plain data (`{value, label, group?}`).
//
// Deliberately does NOT attach its own DOM event listeners: the caller (a
// field-specific module, e.g. `relative-time-field.js`) already owns
// `oninput`/`onkeydown`/`onblur`/`onfocus` on the same `<input>` for its own
// persistence/validation logic, and two independent listeners racing on the
// same key (Enter must either commit an option OR fall through to the
// caller's own commit/harden logic, never both) is a real ordering hazard.
// Instead this module returns an imperative controller — `onInput`,
// `onKeyDown(e) → boolean` (true = consumed, caller should stop), `onFocus`,
// `onBlur`, `onCompositionStart/End` — that the caller invokes from ITS OWN
// listeners, in the same style `applyFieldState` is already called as a
// plain helper from those handlers.
//
// Positioning: the listbox is `position: fixed` (see styles.css), anchored
// under the input via `fixedAnchor` (dom.js) at open time — the same trick
// the File/user menus already use to escape an ancestor's `overflow`
// clipping (the var-strip / dashboard filter bar both scroll horizontally).
// Repositioning only happens on open/refresh, not continuously on scroll —
// a known, minor v1 limitation (documented, not silently ignored).

import { fixedAnchor } from './dom.js';

/** One listbox option — the shape `getOptions`/`onCommit` trade in. */
export interface ComboOption {
  value: string;
  label: string;
  group?: string;
}

/** `onKeyDown`'s minimal event shape — only `key`/`preventDefault` are ever
 *  read, so a real `KeyboardEvent` (from a `keydown` listener) or a small
 *  test fixture both satisfy it structurally, with no cast either way. */
export interface ComboKeyEvent {
  key: string;
  preventDefault(): void;
}

/** The imperative controller `createCombobox` returns — the caller invokes
 *  these from ITS OWN focus/input/keydown/blur/composition listeners (see
 *  the header comment on why this module never attaches its own). */
export interface ComboboxController {
  isOpen(): boolean;
  onFocus(): void;
  onInput(): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  onBlur(): void;
  /** Alias for the close path — for a caller closing on outside interaction. */
  close(): void;
  /** Re-pull `getOptions` for the CURRENT input text and re-render the open
   *  list (incl. the aria-live count) — for a caller whose option source
   *  changed underneath an open list without a keystroke (e.g. "Clear
   *  recent", #171 review F4: the cleared options must leave the visible
   *  listbox too, not just the store). No-op-safe when closed (renders into
   *  the hidden list, which the next open rebuilds anyway). */
  refresh(): void;
  /** @returns true when this key was fully handled — the caller must not
   *  also run its own logic for the same keydown. */
  onKeyDown(e: ComboKeyEvent): boolean;
}

/** A combobox-based field controller's DOM wiring surface — the exact shape
 *  `buildEnumField`/`buildRelativeTimeField`/`buildRecentField` (still-JS
 *  callers) return, each delegating its own hooks to a `ComboboxController`. */
export interface ComboField {
  input: HTMLInputElement;
  onFocus(): void;
  onInput(): void;
  onKeyDown(e: ComboKeyEvent): boolean;
  onBlur(): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
}

// A name-derived, HTML-id-safe suffix for a field module's listbox/live-region
// ids: variable names are scanner-restricted to identifier-shaped tokens in
// practice, but sanitize defensively so a stray character never produces an
// invalid id. Shared by every combobox-based field module (review F8).
export const idSafe = (name: unknown): string => String(name).replace(/[^\w-]/g, '_');

/**
 * Standard DOM wiring for a combobox-based field controller (the object
 * `buildEnumField`/`buildRelativeTimeField`/`buildRecentField` return): the
 * exact focus/input/keydown/blur/composition listener set the workbench
 * var-strip and the dashboard filter bar previously copy-pasted per control
 * kind (review F8). The field's own hooks run FIRST (they delegate to the
 * combobox — see relative-time-field.js's header on why one listener beats
 * two racing ones); a keydown the combobox consumed (nav/escape/option
 * commit) never falls through, and only Enter reaches the caller's
 * hard-commit. `onValueInput` is the caller's persist-on-type body;
 * `onCommit` its blur/Enter hard-commit body.
 */
export function wireComboInput(
  field: ComboField, { onValueInput, onCommit }: { onValueInput: () => void; onCommit: () => void },
): void {
  const input = field.input;
  input.addEventListener('focus', () => field.onFocus());
  input.addEventListener('input', () => { field.onInput(); onValueInput(); });
  input.addEventListener('keydown', (e) => {
    if (field.onKeyDown(e)) return; // the combobox consumed it (nav/escape/option commit)
    if (e.key !== 'Enter') return;
    onCommit();
  });
  input.addEventListener('blur', () => { field.onBlur(); onCommit(); });
  input.addEventListener('compositionstart', () => field.onCompositionStart());
  input.addEventListener('compositionend', () => field.onCompositionEnd());
}

/** `createCombobox`'s options bag. */
export interface CreateComboboxOpts {
  input: HTMLInputElement;
  /** role="listbox" container, initially hidden. */
  listEl: HTMLElement;
  /** aria-live region for result-count announcements. */
  liveEl: HTMLElement;
  document?: Document;
  getOptions: (text: string) => ComboOption[] | null | undefined;
  onCommit: (option: ComboOption) => void;
  /** Fires on every open→closed transition (blur, Esc, Enter-commit,
   *  Enter-with-no-active-option, AND the option mousedown-commit path — see
   *  closeList()). */
  onClose?: () => void;
}

export function createCombobox(
  { input, listEl, liveEl, document: doc, getOptions, onCommit, onClose }: CreateComboboxOpts,
): ComboboxController {
  const d = doc || input.ownerDocument;
  let open = false;
  let composing = false;
  let options: ComboOption[] = [];
  let activeIndex = -1;

  const optionId = (i: number): string =>
    input.id ? `${input.id}-opt-${i}` : `varcombo-opt-${i}-${Math.random().toString(36).slice(2, 8)}`;

  function position(): void {
    const rect = input.getBoundingClientRect();
    // No `viewportW` passed here, so fixedAnchor (dom.ts) always returns its
    // `{top, left}` shape, never the `{top, right}` one — a runtime `'left'
    // in pos` branch to pick between them would be dead code no fixture can
    // exercise (its `else` is unreachable), so the narrowing is a static
    // cast instead.
    const pos = fixedAnchor(rect) as { top: number; left: number };
    listEl.style.top = pos.top + 'px';
    listEl.style.left = pos.left + 'px';
    listEl.style.minWidth = rect.width + 'px';
  }

  function render(): void {
    const ids: string[] = [];
    const children: HTMLElement[] = [];
    let prevGroup: string | undefined;
    options.forEach((o, i) => {
      if (o.group !== prevGroup) {
        children.push(el('li', { class: 'combo-group', role: 'presentation' }, o.group || ''));
        prevGroup = o.group;
      }
      const id = optionId(i);
      ids.push(id);
      const li = el('li', {
        id, role: 'option', class: 'combo-option' + (i === activeIndex ? ' is-active' : ''),
        'aria-selected': String(i === activeIndex),
      }, o.label);
      li.addEventListener('mousedown', (e) => {
        // Commit BEFORE blur (#174 §1): preventDefault stops the input from
        // ever losing focus, so there's no blur race to resolve at all.
        e.preventDefault();
        commit(i);
      });
      children.push(li);
    });
    listEl.replaceChildren(...children);
    if (activeIndex >= 0) input.setAttribute('aria-activedescendant', ids[activeIndex]);
    else input.removeAttribute('aria-activedescendant');
    liveEl.textContent = options.length
      ? `${options.length} option${options.length === 1 ? '' : 's'}`
      : 'No matches';
  }

  function openList(): void {
    open = true;
    listEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    activeIndex = -1;
    options = getOptions(input.value) || [];
    position();
    render();
  }

  function closeList(): void {
    if (!open) return;
    open = false;
    listEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    // Review (phase-7 user feedback): this is the ONE place every close path
    // funnels through — blur, Escape, Enter (with or without an active
    // option), AND an option's mousedown-commit (which closes the list
    // without ever running the field module's own focus/input/keydown/blur
    // handlers, since focus never actually leaves the input). A field module
    // that composes a combo-footer.js footer wires `onClose` to the same
    // `syncFooter()` it already calls from those handlers, so the footer
    // hides immediately on an option pick too — no per-module copy-paste.
    if (onClose) onClose();
  }

  function refresh(): void {
    activeIndex = -1;
    options = getOptions(input.value) || [];
    render();
  }

  // `i` is always a currently-valid option index: it comes either from an
  // option `<li>`'s own render-time closure (rebuilt every render, so a
  // stale index can never outlive its option) or from `activeIndex`, which
  // `openList`/`refresh` reset to -1 and Arrow/Home/End keep clamped to
  // `[0, options.length)` — so no out-of-range guard is reachable here.
  function commit(i: number): void {
    const o = options[i];
    input.value = o.value;
    closeList();
    // Only call .focus() when focus isn't already on the input (the Enter-
    // commit path: the keydown that triggered this already came from a
    // focused input) — some engines refire a 'focus' event even when the
    // element was already focused, which would reopen the list we just
    // closed via the caller's own 'focus' listener (see relative-time-
    // field.js's onFocus wiring). A real per-spec browser wouldn't refire,
    // but this guard makes that not load-bearing.
    if (d.activeElement !== input) input.focus();
    onCommit(o);
  }

  function handleTextChanged(): void {
    if (!open) { openList(); return; }
    refresh();
  }

  return {
    isOpen: () => open,
    onFocus() { openList(); },
    onInput() { if (!composing) handleTextChanged(); },
    onCompositionStart() { composing = true; },
    onCompositionEnd() { composing = false; handleTextChanged(); },
    onBlur() { closeList(); },
    close: closeList,
    refresh,
    onKeyDown(e: ComboKeyEvent): boolean {
      if (composing) return false;
      switch (e.key) {
        case 'ArrowDown':
          if (!open) { openList(); } else { activeIndex = Math.min(options.length - 1, activeIndex + 1); render(); }
          e.preventDefault();
          return true;
        case 'ArrowUp':
          if (!open) { openList(); } else { activeIndex = activeIndex <= 0 ? 0 : activeIndex - 1; render(); }
          e.preventDefault();
          return true;
        case 'Home':
          if (!open || !options.length) return false;
          activeIndex = 0; render(); e.preventDefault(); return true;
        case 'End':
          if (!open || !options.length) return false;
          activeIndex = options.length - 1; render(); e.preventDefault(); return true;
        case 'Enter':
          if (activeIndex >= 0) { commit(activeIndex); e.preventDefault(); return true; }
          closeList();
          return false; // no active option: let the caller's own Enter-commit logic run
        case 'Escape':
          if (!open) return false;
          closeList(); // nothing to restore — arrow nav never mutates input.value (aria-autocomplete="list")
          e.preventDefault();
          return true;
        default:
          return false;
      }
    },
  };

  function el(tag: string, props: Record<string, string>, text?: string): HTMLElement {
    const node = d.createElement(tag);
    for (const k in props) node.setAttribute(k, props[k]);
    if (text != null) node.textContent = text;
    return node;
  }
}
