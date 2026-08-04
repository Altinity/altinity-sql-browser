import { describe, it, expect, vi } from 'vitest';
import {
  showInInspector, releaseInspector, closeInspector, isInspectorOpen,
} from '../../src/ui/inspector-host.js';
import type { InspectorHostApp } from '../../src/ui/inspector-host.js';

// Occupancy is keyed by the HOST ELEMENT (a WeakMap, not one bare module
// global) — each test's own fresh `inspectorHost` is therefore already
// isolated from every other test's, with no shared module state to reset
// between them (unlike dialog-shell.test.ts's single module-local
// `openHandle`, which needs an `afterEach` to force-close a leftover dialog).
// Typed with both nodes required (narrower than InspectorHostApp's own
// optional fields) so ordinary tests below read `app.dom.inspectorHost`
// without a null-check — the dedicated "no host mounted yet" describe block
// further down builds its own explicitly-partial fixtures instead.
function makeApp(): { dom: { inspectorHost: HTMLElement; inspectorResize: HTMLElement } } {
  return {
    dom: {
      inspectorHost: document.createElement('div'),
      inspectorResize: document.createElement('div'),
    },
  };
}

describe('showInInspector / releaseInspector / closeInspector', () => {
  it('unfolds the host: unhides both nodes, mounts the content, and returns true', () => {
    const app = makeApp();
    const content = document.createElement('p');
    content.textContent = 'cell value';
    expect(showInInspector(app, content, vi.fn())).toBe(true);
    expect(app.dom.inspectorHost.hidden).toBe(false);
    expect(app.dom.inspectorResize.hidden).toBe(false);
    expect(app.dom.inspectorHost.firstElementChild).toBe(content);
    expect(isInspectorOpen(app)).toBe(true);
  });

  it('releaseInspector folds the host: hides both nodes and clears content', () => {
    const app = makeApp();
    showInInspector(app, document.createElement('p'), vi.fn());
    releaseInspector(app);
    expect(app.dom.inspectorHost.hidden).toBe(true);
    expect(app.dom.inspectorResize.hidden).toBe(true);
    expect(app.dom.inspectorHost.children).toHaveLength(0);
    expect(isInspectorOpen(app)).toBe(false);
  });

  it('closeInspector is a no-op when the inspector is already folded', () => {
    const app = makeApp();
    expect(isInspectorOpen(app)).toBe(false);
    expect(() => closeInspector(app)).not.toThrow();
    expect(isInspectorOpen(app)).toBe(false);
  });

  it('closeInspector calls the current occupant\'s own close()', () => {
    const app = makeApp();
    const close = vi.fn(() => releaseInspector(app));
    showInInspector(app, document.createElement('p'), close);
    closeInspector(app);
    expect(close).toHaveBeenCalledTimes(1);
    expect(app.dom.inspectorHost.hidden).toBe(true);
  });

  it('a fresh showInInspector force-closes the current occupant BEFORE mounting the new content', () => {
    const app = makeApp();
    const order: string[] = [];
    const firstClose = vi.fn(() => { order.push('first-close'); releaseInspector(app); });
    const first = document.createElement('p');
    first.textContent = 'rows viewer';
    showInInspector(app, first, firstClose);

    const second = document.createElement('p');
    second.textContent = 'cell detail';
    order.push('opening-second');
    showInInspector(app, second, vi.fn());

    // The outgoing occupant's close() ran before the new content was mounted —
    // never the other way around (which would let the outgoing teardown
    // clobber the incoming content).
    expect(order).toEqual(['opening-second', 'first-close']);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(app.dom.inspectorHost.firstElementChild).toBe(second);
    expect(app.dom.inspectorHost.children).toHaveLength(1);
    expect(app.dom.inspectorHost.hidden).toBe(false);
    expect(isInspectorOpen(app)).toBe(true);
  });

  it('only one occupant is ever tracked — closing the CURRENT occupant after it was already replaced is inert (idempotent close on the stale occupant, per SurfaceLifecycle)', () => {
    const app = makeApp();
    let released = false;
    const staleClose = vi.fn(() => { released = true; releaseInspector(app); });
    showInInspector(app, document.createElement('p'), staleClose);
    // Replace it — staleClose already ran once as part of this force-close.
    showInInspector(app, document.createElement('p'), vi.fn());
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(released).toBe(true);
    // The still-mounted second occupant is untouched by the stale reference —
    // there is nothing left pointing at it for a caller to mistakenly re-invoke.
    expect(app.dom.inspectorHost.children).toHaveLength(1);
  });

  it('two independent shells (two host elements) never interfere with each other', () => {
    const appA = makeApp();
    const appB = makeApp();
    const closeA = vi.fn(() => releaseInspector(appA));
    const closeB = vi.fn(() => releaseInspector(appB));
    showInInspector(appA, document.createElement('p'), closeA);
    showInInspector(appB, document.createElement('p'), closeB);
    expect(isInspectorOpen(appA)).toBe(true);
    expect(isInspectorOpen(appB)).toBe(true);
    closeInspector(appA);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();
    expect(isInspectorOpen(appA)).toBe(false);
    expect(isInspectorOpen(appB)).toBe(true);
  });

  // Every AppDom render-target field is optional (matching results.ts's own
  // `resultsRegion` convention) — a real shell always sets both nodes
  // synchronously at mount, before any surface can call in here, but this
  // module never assumes it. These never fire in production; they exist so a
  // caller whose shell hasn't mounted yet (or a narrow test fixture) degrades
  // to a harmless no-op instead of throwing.
  // #586 findings 1/2b: the two shell-owned hooks this module calls at the
  // exact points it folds/unfolds the host, without knowing anything about
  // drag mechanics or layout math itself — just invoking an optional
  // callback on the same `dom` bag it already reads `inspectorHost`/
  // `inspectorResize` off of.
  describe('shell-owned fold/unfold hooks (#586 findings 1/2b)', () => {
    it('showInInspector calls reclampInspectorWidth, when present, before revealing the host', () => {
      const order: string[] = [];
      const app = {
        dom: {
          inspectorHost: document.createElement('div'),
          inspectorResize: document.createElement('div'),
          reclampInspectorWidth: vi.fn(() => { order.push('reclamp'); }),
        },
      };
      app.dom.inspectorHost.hidden = true;
      order.push(app.dom.inspectorHost.hidden ? 'was-hidden' : 'was-visible');
      showInInspector(app, document.createElement('p'), vi.fn());
      expect(app.dom.reclampInspectorWidth).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['was-hidden', 'reclamp']); // reclamp runs before hidden flips to false
      expect(app.dom.inspectorHost.hidden).toBe(false);
    });

    it('showInInspector tolerates a missing reclampInspectorWidth hook', () => {
      const app = makeApp();
      expect(() => showInInspector(app, document.createElement('p'), vi.fn())).not.toThrow();
      expect(app.dom.inspectorHost.hidden).toBe(false);
    });

    it('showInInspector does not call reclampInspectorWidth when the mount itself fails (no host/resize node)', () => {
      const reclamp = vi.fn();
      const noResize = { dom: { inspectorHost: document.createElement('div'), reclampInspectorWidth: reclamp } };
      expect(showInInspector(noResize, document.createElement('p'), vi.fn())).toBe(false);
      expect(reclamp).not.toHaveBeenCalled();
    });

    it('releaseInspector calls cancelInspectorDrag, when present', () => {
      const cancel = vi.fn();
      const app = {
        dom: {
          inspectorHost: document.createElement('div'),
          inspectorResize: document.createElement('div'),
          cancelInspectorDrag: cancel,
        },
      };
      showInInspector(app, document.createElement('p'), vi.fn());
      releaseInspector(app);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(app.dom.inspectorHost.hidden).toBe(true);
    });

    it('releaseInspector tolerates a missing cancelInspectorDrag hook', () => {
      const app = makeApp();
      showInInspector(app, document.createElement('p'), vi.fn());
      expect(() => releaseInspector(app)).not.toThrow();
    });

    it('releaseInspector with no host mounted at all never calls cancelInspectorDrag', () => {
      const cancel = vi.fn();
      const bare: InspectorHostApp = { dom: { cancelInspectorDrag: cancel } };
      releaseInspector(bare);
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  describe('no host mounted yet (AppDom fields absent)', () => {
    it('isInspectorOpen/closeInspector are inert', () => {
      const bare: InspectorHostApp = { dom: {} };
      expect(isInspectorOpen(bare)).toBe(false);
      expect(() => closeInspector(bare)).not.toThrow();
    });

    it('showInInspector is a no-op that returns false when either node is missing', () => {
      const noHost: InspectorHostApp = { dom: { inspectorResize: document.createElement('div') } };
      expect(showInInspector(noHost, document.createElement('p'), vi.fn())).toBe(false);
      expect(isInspectorOpen(noHost)).toBe(false);

      const noResize: InspectorHostApp = { dom: { inspectorHost: document.createElement('div') } };
      expect(showInInspector(noResize, document.createElement('p'), vi.fn())).toBe(false);
      expect(isInspectorOpen(noResize)).toBe(false);
    });

    it('releaseInspector is a no-op with no host, and tolerates a missing resize handle', () => {
      const bare: InspectorHostApp = { dom: {} };
      expect(() => releaseInspector(bare)).not.toThrow();

      const hostOnly: InspectorHostApp = { dom: { inspectorHost: document.createElement('div') } };
      showInInspector(hostOnly, document.createElement('p'), vi.fn()); // no-op (no resize node)
      expect(() => releaseInspector(hostOnly)).not.toThrow();
      expect(hostOnly.dom.inspectorHost!.hidden).toBe(true);
    });
  });
});
