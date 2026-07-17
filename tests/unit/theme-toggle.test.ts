import { describe, it, expect, vi } from 'vitest';
import { toggleThemeDom } from '../../src/ui/theme-toggle.js';
import type { ToggleThemeDomDeps } from '../../src/ui/theme-toggle.js';

function makeDeps(over: Partial<ToggleThemeDomDeps> = {}): ToggleThemeDomDeps & { prefs: { toggleTheme: ReturnType<typeof vi.fn> } } {
  const doc = document.implementation.createHTMLDocument('t');
  return {
    prefs: { toggleTheme: vi.fn(() => 'dark') },
    document: doc,
    themeBtn: () => undefined,
    ...over,
  } as ToggleThemeDomDeps & { prefs: { toggleTheme: ReturnType<typeof vi.fn> } };
}

describe('toggleThemeDom()', () => {
  it('flips the theme via prefs.toggleTheme() and writes data-theme', () => {
    const deps = makeDeps();
    const theme = toggleThemeDom(deps);
    expect(theme).toBe('dark');
    expect(deps.prefs.toggleTheme).toHaveBeenCalledTimes(1);
    expect(deps.document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('is a no-op on the icon swap when no button is mounted (still flips + persists)', () => {
    const deps = makeDeps({ themeBtn: () => undefined });
    expect(() => toggleThemeDom(deps)).not.toThrow();
  });

  it('swaps the mounted button to the sun icon for dark', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const btn = doc.createElement('button');
    btn.appendChild(doc.createElement('span'));
    const deps = makeDeps({ document: doc, prefs: { toggleTheme: vi.fn(() => 'dark') }, themeBtn: () => btn });
    toggleThemeDom(deps);
    expect(btn.children.length).toBe(1);
    expect(btn.querySelector('svg')).toBeTruthy();
  });

  it('swaps the mounted button to the moon icon for light', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const btn = doc.createElement('button');
    const deps = makeDeps({ document: doc, prefs: { toggleTheme: vi.fn(() => 'light') }, themeBtn: () => btn });
    toggleThemeDom(deps);
    expect(btn.querySelector('svg')).toBeTruthy();
  });

  it('resolves the button freshly on every call — a caller can hand back a different element each time', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const btnA = doc.createElement('button');
    const btnB = doc.createElement('button');
    let which: HTMLElement = btnA;
    const deps = makeDeps({ document: doc, themeBtn: () => which });
    toggleThemeDom(deps);
    expect(btnA.querySelector('svg')).toBeTruthy();
    which = btnB;
    toggleThemeDom(deps);
    expect(btnB.querySelector('svg')).toBeTruthy();
  });
});
