import { describe, it, expect, vi } from 'vitest';
import { openSurfaceLifecycle } from '../../src/ui/surface-lifecycle.js';

const key = (target: EventTarget, k: string): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('openSurfaceLifecycle', () => {
  it('close() is idempotent — a second call never re-fires onClose or throws', () => {
    const onClose = vi.fn();
    const panel = document.createElement('div');
    const { close } = openSurfaceLifecycle({
      document, escapePolicy: 'none', panel, returnFocusTo: null, onClose,
    });
    close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(() => close()).not.toThrow();
    close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('isOpen() reflects state before and after close()', () => {
    const panel = document.createElement('div');
    const { close, isOpen } = openSurfaceLifecycle({
      document, escapePolicy: 'none', panel, returnFocusTo: null,
    });
    expect(isOpen()).toBe(true);
    close();
    expect(isOpen()).toBe(false);
  });

  describe('escapePolicy', () => {
    it("'always' closes on Escape regardless of focus location", () => {
      const onClose = vi.fn();
      const panel = document.createElement('div');
      document.body.appendChild(panel);
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      outside.focus();
      const { isOpen } = openSurfaceLifecycle({
        document, escapePolicy: 'always', panel, returnFocusTo: null, onClose,
      });
      key(document, 'Escape');
      expect(isOpen()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
      panel.remove();
      outside.remove();
    });

    it("'focus-inside' closes only while focus is inside panel — Escape elsewhere is a no-op", () => {
      const onClose = vi.fn();
      const panel = document.createElement('div');
      const inner = document.createElement('button');
      panel.appendChild(inner);
      document.body.appendChild(panel);
      const outside = document.createElement('button');
      document.body.appendChild(outside);

      outside.focus();
      const { isOpen } = openSurfaceLifecycle({
        document, escapePolicy: 'focus-inside', panel, returnFocusTo: null, onClose,
      });
      key(document, 'Escape');
      expect(isOpen()).toBe(true); // focus was outside — untouched
      expect(onClose).not.toHaveBeenCalled();

      inner.focus();
      key(document, 'Escape');
      expect(isOpen()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
      panel.remove();
      outside.remove();
    });

    it("'none' installs no Escape handling at all — the caller owns Escape entirely", () => {
      const onClose = vi.fn();
      const panel = document.createElement('div');
      const { isOpen } = openSurfaceLifecycle({
        document, escapePolicy: 'none', panel, returnFocusTo: null, onClose,
      });
      key(document, 'Escape');
      expect(isOpen()).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("a 'none' surface's close() still tears down cleanly (no listener was ever installed to remove)", () => {
      const panel = document.createElement('div');
      const { close } = openSurfaceLifecycle({
        document, escapePolicy: 'none', panel, returnFocusTo: null,
      });
      expect(() => close()).not.toThrow();
    });
  });

  describe('returnFocusTo', () => {
    it('an element is focused on close', () => {
      const panel = document.createElement('div');
      const target = document.createElement('button');
      document.body.appendChild(target);
      const { close } = openSurfaceLifecycle({
        document, escapePolicy: 'none', panel, returnFocusTo: target,
      });
      close();
      expect(document.activeElement).toBe(target);
      target.remove();
    });

    it('a resolver is called AT close time, not at open time', () => {
      const panel = document.createElement('div');
      let target: HTMLButtonElement | null = null;
      const { close } = openSurfaceLifecycle({
        document, escapePolicy: 'none', panel, returnFocusTo: () => target,
      });
      target = document.createElement('button'); // created only after open()
      document.body.appendChild(target);
      close();
      expect(document.activeElement).toBe(target);
      target.remove();
    });

    it('null means nothing is focused — close() does not throw when nothing is on screen to restore to', () => {
      const panel = document.createElement('div');
      const { close } = openSurfaceLifecycle({
        document, escapePolicy: 'none', panel, returnFocusTo: null,
      });
      expect(() => close()).not.toThrow();
    });

    it('a resolver returning null is a harmless no-op restore', () => {
      const panel = document.createElement('div');
      const { close } = openSurfaceLifecycle({
        document, escapePolicy: 'none', panel, returnFocusTo: () => null,
      });
      expect(() => close()).not.toThrow();
    });
  });

  describe('keyboard-owner acquisition', () => {
    it('acquires on open and releases on close when acquireKeyboardOwner is supplied', () => {
      const release = vi.fn();
      const acquireKeyboardOwner = vi.fn().mockReturnValue(release);
      const panel = document.createElement('div');
      const { close } = openSurfaceLifecycle({
        document, escapePolicy: 'none', panel, returnFocusTo: null, acquireKeyboardOwner,
      });
      expect(acquireKeyboardOwner).toHaveBeenCalledWith('modal');
      expect(release).not.toHaveBeenCalled();
      close();
      expect(release).toHaveBeenCalledTimes(1);
      close(); // idempotent — no double release
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('omitting acquireKeyboardOwner never acquires or releases anything (a non-modal surface)', () => {
      const panel = document.createElement('div');
      expect(() => {
        const { close } = openSurfaceLifecycle({
          document, escapePolicy: 'none', panel, returnFocusTo: null,
        });
        close();
      }).not.toThrow();
    });
  });
});
