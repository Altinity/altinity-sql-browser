import { describe, it, expect, vi } from 'vitest';
import { attachComboFooter } from '../../src/ui/combo-footer.js';

function makeParts() {
  const input = document.createElement('input');
  const listEl = document.createElement('ul');
  document.body.append(input, listEl);
  return { input, listEl };
}

function fakeCombo(open) {
  return { isOpen: () => open };
}

describe('attachComboFooter', () => {
  it('starts hidden', () => {
    const { input, listEl } = makeParts();
    const { el } = attachComboFooter({ input, listEl, combo: fakeCombo(false), hasRecents: () => true, onClear: vi.fn() });
    expect(el.hidden).toBe(true);
    expect(el.classList.contains('var-combo-footer')).toBe(true);
  });
  it('sync() hides when the combobox is closed, even with recents', () => {
    const { input, listEl } = makeParts();
    const { el, sync } = attachComboFooter({ input, listEl, combo: fakeCombo(false), hasRecents: () => true, onClear: vi.fn() });
    sync();
    expect(el.hidden).toBe(true);
  });
  it('sync() hides when open but there are no recents for this field', () => {
    const { input, listEl } = makeParts();
    const { el, sync } = attachComboFooter({ input, listEl, combo: fakeCombo(true), hasRecents: () => false, onClear: vi.fn() });
    sync();
    expect(el.hidden).toBe(true);
  });
  it('sync() shows and positions the footer when open with recents', () => {
    const { input, listEl } = makeParts();
    const { el, sync } = attachComboFooter({ input, listEl, combo: fakeCombo(true), hasRecents: () => true, onClear: vi.fn() });
    sync();
    expect(el.hidden).toBe(false);
    expect(el.style.top).toMatch(/px$/);
    expect(el.style.left).toMatch(/px$/);
    expect(el.style.minWidth).toMatch(/px$/);
  });
  it('the Clear button has tabindex -1 (never steals Tab focus) and a stable label', () => {
    const { input, listEl } = makeParts();
    const { el } = attachComboFooter({ input, listEl, combo: fakeCombo(true), hasRecents: () => true, onClear: vi.fn() });
    const btn = el.querySelector('button.var-combo-clear');
    expect(btn.getAttribute('tabindex')).toBe('-1');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.textContent).toBe('Clear recent');
  });
  it('clicking Clear preventDefaults the mousedown (stays open, no blur), calls onClear, and re-syncs', () => {
    const { input, listEl } = makeParts();
    let hasRecents = true;
    const onClear = vi.fn(() => { hasRecents = false; });
    const { el, sync } = attachComboFooter({ input, listEl, combo: fakeCombo(true), hasRecents: () => hasRecents, onClear });
    sync();
    expect(el.hidden).toBe(false);
    const btn = el.querySelector('button.var-combo-clear');
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const prevented = !btn.dispatchEvent(evt);
    expect(prevented).toBe(true);
    expect(onClear).toHaveBeenCalledTimes(1);
    // onClear flipped hasRecents to false; the button's own mousedown handler
    // re-syncs, so the footer hides itself immediately (no history left).
    expect(el.hidden).toBe(true);
  });
});
