import { describe, it, expect, vi, afterEach } from 'vitest';
import { openMenu } from '../../src/ui/menu.js';
import type { MenuRow } from '../../src/ui/menu.js';

const key = (target: EventTarget, k: string): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const click = (el: Element): boolean => el.dispatchEvent(new Event('click', { bubbles: true }));
const flush = (): Promise<void> => new Promise((r) => setTimeout(r));

afterEach(() => document.body.replaceChildren());

function trigger(): HTMLButtonElement {
  const btn = document.createElement('button');
  document.body.appendChild(btn);
  return btn;
}

function itemRow(label: string, onClick = vi.fn(), extra: Partial<MenuRow & { kind: 'item' }> = {}): MenuRow {
  return { kind: 'item', label, onClick, ...extra };
}

describe('openMenu — structure (every row kind)', () => {
  it('renders item (icon+label+meta), section, sep, and a plain custom row', () => {
    const btn = trigger();
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const custom = document.createElement('div');
    custom.className = 'my-custom-row';
    const onClick = vi.fn();
    const handle = openMenu({
      document, trigger: btn,
      rows: [
        { kind: 'item', icon, label: 'Do thing', meta: '.json', onClick },
        { kind: 'section', label: 'A section' },
        { kind: 'sep' },
        { kind: 'custom', node: custom },
      ],
    });
    expect(handle.el.classList.contains('file-menu')).toBe(true);
    expect(handle.el.getAttribute('role')).toBe('menu');
    const item = handle.el.querySelector('.fm-item')!;
    expect(item.querySelector('.fm-icon svg')).not.toBeNull();
    expect(item.querySelector('.fm-label')!.textContent).toBe('Do thing');
    expect(item.querySelector('.fm-meta')!.textContent).toBe('.json');
    expect(item.getAttribute('role')).toBe('menuitem');
    expect(handle.el.querySelector('.fm-section')!.textContent).toBe('A section');
    expect(handle.el.querySelector('.fm-sep')).not.toBeNull();
    expect(handle.el.querySelector('.my-custom-row')).not.toBeNull();
  });

  it('an item with no icon/meta renders no .fm-icon/.fm-meta', () => {
    const btn = trigger();
    const handle = openMenu({ document, trigger: btn, rows: [itemRow('Plain')] });
    const item = handle.el.querySelector('.fm-item')!;
    expect(item.querySelector('.fm-icon')).toBeNull();
    expect(item.querySelector('.fm-meta')).toBeNull();
  });

  it('extraClass adds a marker class alongside .fm-item; menuClass adds one to the menu itself', () => {
    const btn = trigger();
    const handle = openMenu({
      document, trigger: btn, menuClass: 'dash-file-menu',
      rows: [itemRow('X', vi.fn(), { extraClass: 'dash-fm-item' })],
    });
    expect(handle.el.classList.contains('dash-file-menu')).toBe(true);
    expect(handle.el.querySelector('.fm-item')!.classList.contains('dash-fm-item')).toBe(true);
  });

  it('mounts under document.body, anchored under the trigger', () => {
    const btn = trigger();
    const handle = openMenu({ document, trigger: btn, rows: [itemRow('X')] });
    expect(handle.el.parentElement).toBe(document.body);
    expect(handle.el.style.position).toBe('fixed');
  });
});

describe('openMenu — item click', () => {
  it('closes the menu, then fires onClick', () => {
    const onClick = vi.fn();
    const btn = trigger();
    const handle = openMenu({ document, trigger: btn, rows: [itemRow('Go', onClick)] });
    const closeSpy = vi.spyOn(handle, 'close');
    click(handle.el.querySelector('.fm-item')!);
    expect(document.querySelector('.file-menu')).toBeNull();
    expect(onClick).toHaveBeenCalledOnce();
    void closeSpy; // documents intent; real assertion is via onClose below
  });

  it('runs onClose exactly once, even if close() were called again', () => {
    const onClose = vi.fn();
    const btn = trigger();
    const handle = openMenu({ document, trigger: btn, rows: [itemRow('Go')], onClose });
    handle.close();
    handle.close(); // idempotent — no double-fire
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('openMenu — aria + trigger', () => {
  it('sets aria-haspopup/aria-expanded=true on open, aria-expanded=false on close', () => {
    const btn = trigger();
    const handle = openMenu({ document, trigger: btn, rows: [itemRow('X')] });
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    handle.close();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('openMenu — autofocus', () => {
  it('focuses the first focusable row after open', async () => {
    const btn = trigger();
    const handle = openMenu({ document, trigger: btn, rows: [itemRow('First'), itemRow('Second')] });
    await flush();
    expect(document.activeElement).toBe(handle.el.querySelectorAll('.fm-item')[0]);
  });

  it('does nothing (no throw) when there are no focusable rows', async () => {
    const btn = trigger();
    openMenu({ document, trigger: btn, rows: [{ kind: 'section', label: 'Empty' }] });
    await flush(); // no focusable[0] to focus — must not throw
    expect(document.querySelector('.file-menu')).not.toBeNull();
  });
});

describe('openMenu — Escape + focus-restore', () => {
  it('closes and restores focus to the trigger', () => {
    const btn = trigger();
    openMenu({ document, trigger: btn, rows: [itemRow('X')] });
    key(document, 'Escape');
    expect(document.querySelector('.file-menu')).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('an unrelated key is ignored (menu stays open)', () => {
    const btn = trigger();
    openMenu({ document, trigger: btn, rows: [itemRow('X')] });
    key(document, 'a');
    expect(document.querySelector('.file-menu')).not.toBeNull();
  });
});

describe('openMenu — overlay close', () => {
  it('clicking the overlay closes the menu', () => {
    const btn = trigger();
    openMenu({ document, trigger: btn, rows: [itemRow('X')] });
    click(document.querySelector('.fm-overlay')!);
    expect(document.querySelector('.file-menu')).toBeNull();
    expect(document.querySelector('.fm-overlay')).toBeNull();
  });
});

describe('openMenu — re-open is a no-op', () => {
  it('a second openMenu call on the same still-open trigger returns the SAME handle, no second menu', () => {
    const btn = trigger();
    const first = openMenu({ document, trigger: btn, rows: [itemRow('X')] });
    const second = openMenu({ document, trigger: btn, rows: [itemRow('Y — should not appear')] });
    expect(second).toBe(first);
    expect(document.querySelectorAll('.file-menu')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Y — should not appear');
  });

  it('after closing, a fresh openMenu call on the same trigger rebuilds', () => {
    const btn = trigger();
    const first = openMenu({ document, trigger: btn, rows: [itemRow('X')] });
    first.close();
    const second = openMenu({ document, trigger: btn, rows: [itemRow('Y')] });
    expect(second).not.toBe(first);
    expect(document.querySelectorAll('.file-menu')).toHaveLength(1);
    expect(document.body.textContent).toContain('Y');
  });
});

describe('openMenu — roving focus (ArrowDown/ArrowUp)', () => {
  it('ArrowDown moves forward across item rows, wrapping past the last back to the first', () => {
    const btn = trigger();
    const handle = openMenu({ document, trigger: btn, rows: [itemRow('A'), itemRow('B'), itemRow('C')] });
    const [a, b, c] = handle.el.querySelectorAll<HTMLButtonElement>('.fm-item');
    a.focus();
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(b);
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(c);
    key(document, 'ArrowDown'); // wraps
    expect(document.activeElement).toBe(a);
  });

  it('ArrowUp moves backward, wrapping past the first back to the last', () => {
    const btn = trigger();
    const handle = openMenu({ document, trigger: btn, rows: [itemRow('A'), itemRow('B'), itemRow('C')] });
    const [a, b, c] = handle.el.querySelectorAll<HTMLButtonElement>('.fm-item');
    b.focus();
    key(document, 'ArrowUp');
    expect(document.activeElement).toBe(a);
    key(document, 'ArrowUp'); // wraps
    expect(document.activeElement).toBe(c);
  });

  it('a custom row with focusable:true is a roving-focus stop, targeting its own input', () => {
    const btn = trigger();
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    label.appendChild(input);
    const handle = openMenu({
      document, trigger: btn,
      rows: [itemRow('First'), { kind: 'custom', node: label, focusable: true }, itemRow('Last')],
    });
    const first = handle.el.querySelector<HTMLButtonElement>('.fm-item')!;
    first.focus();
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(input); // focuses the descendant, not the <label>
  });

  it('a custom row that is neither focusable itself nor has a focusable descendant still gets targeted as-is (the || node fallback)', () => {
    const btn = trigger();
    const bare = document.createElement('div'); // no tabindex, no focusable children
    const handle = openMenu({
      document, trigger: btn,
      rows: [itemRow('First'), { kind: 'custom', node: bare, focusable: true }],
    });
    const first = handle.el.querySelector<HTMLButtonElement>('.fm-item')!;
    first.focus();
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(bare);
  });

  it('a custom row that is itself directly focusable (no descendant) is targeted as-is', () => {
    const btn = trigger();
    const focusableDiv = document.createElement('div');
    focusableDiv.tabIndex = 0;
    const handle = openMenu({
      document, trigger: btn,
      rows: [itemRow('First'), { kind: 'custom', node: focusableDiv, focusable: true }],
    });
    const first = handle.el.querySelector<HTMLButtonElement>('.fm-item')!;
    first.focus();
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(focusableDiv);
  });

  it('a custom row without focusable:true is skipped by roving focus', () => {
    const btn = trigger();
    const skip = document.createElement('div');
    const handle = openMenu({
      document, trigger: btn,
      rows: [itemRow('First'), { kind: 'custom', node: skip }, itemRow('Last')],
    });
    const [first, last] = handle.el.querySelectorAll<HTMLButtonElement>('.fm-item');
    first.focus();
    key(document, 'ArrowDown');
    expect(document.activeElement).toBe(last); // skipped the non-focusable custom row
  });

  it('Arrow keys are a no-op when there are no focusable rows at all', () => {
    const btn = trigger();
    openMenu({ document, trigger: btn, rows: [{ kind: 'section', label: 'Empty' }, { kind: 'sep' }] });
    expect(() => key(document, 'ArrowDown')).not.toThrow();
    expect(document.querySelector('.file-menu')).not.toBeNull();
  });
});
