// The "Clear recent" dropdown footer (#171) — a small, separately-positioned
// element shared by relative-time-field.js (the combined presets+recents
// dropdown) and recent-field.js (the recents-only dropdown), both of which
// wrap combobox.js's `createCombobox` primitive. combobox.js's own header
// comment records a deliberate decision that #171 reuses it *unchanged* — its
// `listEl` is fully owned by `render()` (replaceChildren on every open/
// keystroke), so a persistent non-option footer row can't live inside it
// without being wiped, and treating "Clear recent" as a selectable listbox
// `<li role="option">` would be an ARIA regression (a screen reader can't
// distinguish a real recent value from a destructive action sharing its own
// role). So this is its own small `position: fixed` element, positioned off
// `listEl`'s own (already zoom-corrected) rect — see dom.js's fixedAnchor/
// zoomScale, the same recipe combobox.js's own `position()` uses for `listEl`
// itself, just anchored one box lower. `sync()` re-measures on every call
// (open/keystroke/nav all resize `listEl` as options are filtered in/out), so
// the caller must call it after every delegated combobox method — exactly
// the composition pattern relative-time-field.js already uses for its own
// live preview.
//
// `hasRecents()` — not the current keystroke's *filtered* result — decides
// visibility: a field with recents "somewhere" still offers Clear even while
// a specific typed filter currently shows no matches.

import { h, fixedAnchor, zoomScale } from './dom.js';

/**
 * @param {{
 *   input: HTMLInputElement, listEl: HTMLElement,
 *   combo: ReturnType<typeof import('./combobox.js').createCombobox>,
 *   hasRecents: () => boolean, onClear: () => void,
 * }} opts
 * @returns {{el: HTMLElement, sync: () => void}}
 */
export function attachComboFooter({ input, listEl, combo, hasRecents, onClear }) {
  const btn = h('button', {
    type: 'button', class: 'var-combo-clear', tabindex: '-1',
    onmousedown: (e) => {
      // Same trick as combobox.js's own option `<li>` mousedown (#174 §1):
      // preventDefault stops the input from ever blurring, so there's no
      // blur-race to resolve — Clear can run and the list stays open.
      e.preventDefault();
      onClear();
      sync();
    },
  }, 'Clear recent');
  const el = h('div', { class: 'var-combo-footer', hidden: true }, btn);

  function sync() {
    if (!combo.isOpen() || !hasRecents()) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const rect = listEl.getBoundingClientRect();
    const scale = zoomScale(input);
    const pos = fixedAnchor(rect, scale, { gap: 0 });
    el.style.top = pos.top + 'px';
    el.style.left = pos.left + 'px';
    el.style.minWidth = (rect.width / scale) + 'px';
  }

  return { el, sync };
}
