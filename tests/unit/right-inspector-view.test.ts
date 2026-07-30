// #577 state S2's Preact right-inspector treatment.
//
// This file pins the SAME behavioural contract as `right-inspector.test.ts`
// (the S1 vanilla control) — see `src/ui/shell/right-inspector-view.ts`'s own
// header. The S1→S2 delta is the evaluation's only architectural comparison,
// so a weakened assertion here would silently corrupt it: every rule below is
// reproduced from the control, unweakened, against the component arm.
//
// Held to the repo's real per-file floor (100/95/90/100).
//
// Preact detail this file leans on throughout: a signal write does NOT paint
// synchronously — Preact schedules the re-render (and the `useLayoutEffect`
// that settles focus) on a microtask. Every assertion that depends on the
// POST-change DOM therefore awaits `flush()` first. Reading `model.*` signal
// values themselves needs no flush (those are plain synchronous reads), only
// reading rendered DOM/attributes does.

import { describe, it, expect, vi } from 'vitest';
// Side-effect only: `@preact/signals` patches Preact's shared `options` hooks
// so a function component that reads a signal's `.value` directly during its
// own render (as `InspectorView` does — no `useComputed`/`useSignal` wrapper
// anywhere in it) is automatically re-run when that signal changes. Without
// this import nothing here is wrong per se, but nothing ever repaints either:
// `@preact/signals-core` alone has no opinion about Preact at all. The
// package is already a listed dependency for exactly this reason (see the
// ADR-0001 Preact-spike addendum); this test file is the one place that
// actually exercises the wiring for this arm today.
import { h, render } from 'preact';
import { signal } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import {
  createInspectorModel, InspectorView, RIGHT_INSPECTOR_TOOLS,
} from '../../src/ui/shell/right-inspector-view.js';
import type { InspectorApp, InspectorModel, InspectorTool } from '../../src/ui/shell/right-inspector-view.js';

const qs = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => root.querySelector(selector) as T;

/** A microtask flush: Preact schedules its re-render (and any
 *  `useLayoutEffect`) on a microtask, never synchronously with the signal
 *  write that triggered it. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** `object` first, same bridge `app.test.ts`'s own `asWindow` uses — lets a
 *  plain fixture stand in for the full DOM `Window` type `InspectorModelDeps`
 *  declares, without widening that field to `unknown` for every caller. */
const asWindow = (v: object): Window => v as Window;

/** Fake `window`-shaped seam, mirroring `splitters.test.ts`'s own `fakeWin`:
 *  single handler per event type (this pane never registers two at once for
 *  the same type) plus a manual `_fire`, so a drag is driven deterministically
 *  instead of racing real browser mouse events. */
function fakeWin(innerWidth = 1024) {
  const handlers: Record<string, (ev: MouseEvent) => void> = {};
  return {
    innerWidth,
    addEventListener: (t: string, fn: (ev: MouseEvent) => void) => { handlers[t] = fn; },
    removeEventListener: vi.fn((t: string) => { delete handlers[t]; }),
    _fire: (t: string, ev: Partial<MouseEvent> = {}) => { handlers[t]?.(ev as MouseEvent); },
  };
}

/** A tool whose body carries focusable + input state, so the DOM-preservation
 *  contract is actually observable rather than assumed — same shape as S1's
 *  own `makeTool` fixture. */
function makeTool(id: string, label = id): InspectorTool {
  return {
    id,
    label,
    mount: (doc) => {
      const el = doc.createElement('div');
      el.className = `tool-${id}`;
      const input = doc.createElement('input');
      input.className = `input-${id}`;
      el.appendChild(input);
      return el;
    },
  };
}

interface Fixture {
  model: InspectorModel;
  container: HTMLDivElement;
  isMobile: Signal<boolean>;
  save: ReturnType<typeof vi.fn>;
  win: ReturnType<typeof fakeWin>;
}

/** Build the model, mount `InspectorView` into a fresh container appended to
 *  `document.body` (focus tests need a real, attached document), and hand
 *  back the pieces a spec needs. Preact's first render is synchronous, so the
 *  DOM is ready the moment this returns — no flush needed for the initial
 *  paint, only for anything that happens after. */
function mount(tools: InspectorTool[] = [makeTool('a'), makeTool('b')], opts: {
  announce?: (message: string) => void;
  inspectorPx?: number;
  isMobileInit?: boolean;
} = {}): Fixture {
  const isMobile = signal(opts.isMobileInit ?? false);
  const save = vi.fn();
  const app: InspectorApp = { state: { inspectorPx: opts.inspectorPx ?? 420, isMobile }, prefs: { save } };
  const win = fakeWin();
  const model = createInspectorModel({ app, document, tools, announce: opts.announce, win: asWindow(win) });
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(h(InspectorView, { model }), container);
  return { model, container, isMobile, save, win };
}

describe('structure & initial paint', () => {
  it('composes the expected skeleton: panel > head (chevron, tabs, close), body, resize handle', () => {
    const { container, model } = mount();
    const root = qs(container, '.right-inspector');
    expect(model.el()).toBe(root);
    const panel = qs(root, '.ri-panel');
    expect(qs(panel, '.ri-head')).not.toBeNull();
    expect(qs(panel, '.ri-chevron')).toBe(model.chevron());
    expect(qs(panel, '.ri-tabs')).not.toBeNull();
    expect(qs(panel, '.ri-close')).not.toBeNull();
    expect(qs(panel, '.ri-body')).not.toBeNull();
    expect(qs(panel, '.cd-resize-h')).not.toBeNull();
  });

  it('renders one tab per tool, in order, labelled from the tool', () => {
    const { container } = mount([makeTool('a', 'Alpha'), makeTool('b', 'Beta')]);
    const tabs = [...container.querySelectorAll('.ri-tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Alpha', 'Beta']);
    expect(tabs.map((t) => (t as HTMLElement).dataset.tool)).toEqual(['a', 'b']);
  });

  it('mounts and exposes only the FIRST tool at mount — never an empty box, and never a slot for a tool nobody activated yet', () => {
    // #487 phase 3 shipped exactly the "never an empty box" bug for the left
    // History section; the second half (no slot for an un-mounted tool) is
    // this component's own `.filter(entry.el !== null)` branch.
    const { container, model } = mount();
    expect(model.activeToolId.value).toBe('a');
    const slots = [...container.querySelectorAll('.ri-tool-slot')];
    expect(slots).toHaveLength(1);
    expect(qs(container, '.tool-a')).not.toBeNull();
    expect(container.querySelector('.tool-b')).toBeNull();
  });

  it('applies the persisted width from inspectorPx, clamped through the shared primitive', () => {
    const { container } = mount([makeTool('a')], { inspectorPx: 500 });
    expect(qs(container, '.ri-panel').style.width).toBe('500px');
  });

  it('starts expanded, with the chevron labelled for collapsing', () => {
    const { model } = mount();
    expect(model.folded.value).toBe(false);
    expect(model.chevron()!.getAttribute('aria-expanded')).toBe('true');
    expect(model.chevron()!.getAttribute('aria-label')).toBe('Collapse inspector');
  });

  it('hides the whole pane when isMobile starts true', () => {
    const { container } = mount([makeTool('a')], { isMobileInit: true });
    expect(qs(container, '.right-inspector').hidden).toBe(true);
  });

  it('tolerates an empty tool list without throwing (coverage: the tools.length ternary and the initial-tool-null skip)', () => {
    const { model, container } = mount([]);
    expect(model.activeToolId.value).toBeNull();
    expect(container.querySelectorAll('.ri-tab')).toHaveLength(0);
    expect(container.querySelectorAll('.ri-tool-slot')).toHaveLength(0);
  });

  it('falls back to document.defaultView and to 0px when win/inspectorPx are not supplied (coverage of both `||`/`??` fallbacks)', () => {
    const isMobile = signal(false);
    const app: InspectorApp = { state: { isMobile }, prefs: { save: vi.fn() } };
    const model = createInspectorModel({ app, document, tools: [] });
    // clampDrawerWidth(0, 1024) under happy-dom's default window.innerWidth.
    expect(model.widthPx.value).toBe(320);
    model.dispose();
  });

  it('falls back to the ambient window when doc.defaultView is null (coverage of the third `||` fallback — a detached document not yet attached to a browsing context, mirroring drawer.test.ts\'s own case)', () => {
    const detachedDoc = document.implementation.createHTMLDocument('detached');
    expect(detachedDoc.defaultView).toBeNull();
    const isMobile = signal(false);
    const app: InspectorApp = { state: { inspectorPx: 9999, isMobile }, prefs: { save: vi.fn() } };
    const model = createInspectorModel({ app, document: detachedDoc, tools: [] });
    // Clamps against the ambient window's innerWidth (1024 under happy-dom).
    expect(model.widthPx.value).toBe(1024 * 0.92);
    model.dispose();
  });
});

describe('rule 1 — DOM preservation across a fold', () => {
  it('a value typed into .ri-tool-input survives a fold/unfold round trip on the SAME element', async () => {
    // Uses the real exported tool set (not the local `makeTool` fixture)
    // because the rule names `.ri-tool-input` explicitly — this is the actual
    // shipped tool, not a stand-in.
    const { model, container } = mount(RIGHT_INSPECTOR_TOOLS);
    const input = qs<HTMLInputElement>(container, '.ri-tool-input');
    input.value = 'typed value';

    model.setFolded(true);
    await flush();
    model.setFolded(false);
    await flush();

    // Identity, not just equal content: the tool element must never be
    // re-created by the fold/unfold round trip.
    expect(qs<HTMLInputElement>(container, '.ri-tool-input')).toBe(input);
    expect(qs<HTMLInputElement>(container, '.ri-tool-input').value).toBe('typed value');
  });
});

describe('rules 2 & 3 — focus settlement', () => {
  it('RULE 2: focusing .ri-tool-input then folding settles focus on the chevron, never body, never a hidden control', async () => {
    const { model, container } = mount(RIGHT_INSPECTOR_TOOLS);
    const input = qs<HTMLInputElement>(container, '.ri-tool-input');
    input.focus();
    expect(document.activeElement).toBe(input);

    model.setFolded(true);
    await flush();

    expect(document.activeElement).toBe(model.chevron());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('RULE 3: focus outside the pane is not stolen by a fold', async () => {
    const { model } = mount(RIGHT_INSPECTOR_TOOLS);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    model.setFolded(true);
    await flush();

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('rules 4 & 5 — a live resize is cancelled by fold/dispose', () => {
  /** Real mousedown on the rendered `.cd-resize-h` handle, exactly as a user
   *  gesture would, leaving the pointer "down" (no matching mouseup yet). */
  function startRealDrag(container: HTMLElement): void {
    const grip = qs<HTMLElement>(container, '.cd-resize-h');
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 900 }));
  }

  it('RULE 4: folding mid-drag reverts widthPx to the pre-drag value and the abandoned mouseup never persists a width', () => {
    const { model, container, save, win } = mount([makeTool('a')], { inspectorPx: 420 });
    const startWidth = model.widthPx.value;
    expect(startWidth).toBe(420);

    startRealDrag(container);
    win._fire('mousemove', { clientX: 700 } as MouseEvent);
    // Sanity: the drag actually moved the live width before the fold cancels it.
    expect(model.widthPx.value).toBe(324); // clampDrawerWidth(1024-700, 1024)
    expect(model.widthPx.value).not.toBe(startWidth);

    model.setFolded(true); // fold lands mid-gesture
    expect(model.widthPx.value).toBe(startWidth);

    win._fire('mouseup'); // the abandoned drag's trailing mouseup
    expect(save).not.toHaveBeenCalled();
    expect(model.widthPx.value).toBe(startWidth);
  });

  it('RULE 5: dispose() mid-drag also reverts widthPx and the trailing mouseup persists nothing', () => {
    const { model, container, save, win } = mount([makeTool('a')], { inspectorPx: 420 });
    startRealDrag(container);
    win._fire('mousemove', { clientX: 700 } as MouseEvent);
    expect(model.widthPx.value).toBe(324);

    model.dispose();
    expect(model.widthPx.value).toBe(420);

    win._fire('mouseup');
    expect(save).not.toHaveBeenCalled();
  });

  it('dispose() with no drag in progress is a no-op (coverage: cancelResize\'s null-guard branch taken from dispose)', () => {
    const { model } = mount();
    expect(() => model.dispose()).not.toThrow();
  });

  it('a completed (non-cancelled) drag DOES apply the live width and persist it — the baseline the cancellation rules above are measured against', () => {
    const { model, container, save, win } = mount([makeTool('a')], { inspectorPx: 420 });
    startRealDrag(container);
    win._fire('mousemove', { clientX: 700 } as MouseEvent);
    expect(model.widthPx.value).toBe(324);
    win._fire('mouseup');
    expect(save).toHaveBeenCalledWith('inspectorPx', 324);
  });
});

describe('rule 6 — setFolded is idempotent', () => {
  it('folding an already-folded pane does nothing and does not announce a second time', () => {
    const announce = vi.fn();
    const { model } = mount([makeTool('a')], { announce });
    model.setFolded(true);
    expect(announce).toHaveBeenCalledTimes(1);
    model.setFolded(true); // no-op: already folded
    expect(model.folded.value).toBe(true);
    expect(announce).toHaveBeenCalledTimes(1); // not called again
  });

  it('unfolding an already-unfolded pane does nothing and does not announce', () => {
    const announce = vi.fn();
    const { model } = mount([makeTool('a')], { announce });
    model.setFolded(false); // already unfolded at mount
    expect(model.folded.value).toBe(false);
    expect(announce).not.toHaveBeenCalled();
  });
});

describe('rules 7 & 8 — showTool: unknown id is a no-op, folded pane is a reveal', () => {
  it('RULE 7: an unknown tool id leaves the pane exactly as it is', async () => {
    const { model, container } = mount([makeTool('a'), makeTool('b')]);
    model.showTool('does-not-exist');
    await flush();
    expect(model.activeToolId.value).toBe('a');
    const slot = qs(container, '.tool-a').closest('.ri-tool-slot') as HTMLElement;
    expect(slot.hidden).toBe(false); // pane is not blanked
    expect(container.querySelector('.tool-b')).toBeNull(); // still never mounted
  });

  it('RULE 8: selecting a tool while the pane is folded unfolds it — a reveal, not just a switch', async () => {
    const { model } = mount([makeTool('a'), makeTool('b')]);
    model.setFolded(true);
    expect(model.folded.value).toBe(true);

    model.showTool('b');
    await flush();

    expect(model.folded.value).toBe(false);
    expect(model.activeToolId.value).toBe('b');
  });
});

describe('rule 9 — chevron affordances track fold state; glyph is replaced, not appended', () => {
  it('aria-expanded, aria-label, title and the single glyph child all track several fold/unfold cycles', async () => {
    const { model } = mount([makeTool('a')]);
    const chevron = model.chevron()!;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      model.setFolded(true);
      await flush();
      expect(model.chevron()).toBe(chevron); // the button itself is never re-created
      expect(chevron.getAttribute('aria-expanded')).toBe('false');
      expect(chevron.getAttribute('aria-label')).toBe('Expand inspector');
      expect(chevron.title).toBe('Expand inspector');
      expect(chevron.children).toHaveLength(1); // replaced, not appended beside

      model.setFolded(false);
      await flush();
      expect(chevron.getAttribute('aria-expanded')).toBe('true');
      expect(chevron.getAttribute('aria-label')).toBe('Collapse inspector');
      expect(chevron.title).toBe('Collapse inspector');
      expect(chevron.children).toHaveLength(1);
    }
  });
});

describe('rule 10 — announce', () => {
  it("announces 'Inspector collapsed' then 'Inspector expanded' through the injected seam", () => {
    const announce = vi.fn();
    const { model } = mount([makeTool('a')], { announce });
    model.setFolded(true);
    model.setFolded(false);
    expect(announce.mock.calls.map((c) => c[0])).toEqual(['Inspector collapsed', 'Inspector expanded']);
  });

  it('omitting the announce dep does not throw', () => {
    const { model } = mount([makeTool('a')]); // no announce passed
    expect(() => model.setFolded(true)).not.toThrow();
    expect(() => model.setFolded(false)).not.toThrow();
  });
});

describe('rule 11 — the mobile projection REACTS to a later isMobile change', () => {
  it('unlike S1 (which samples isMobile once at mount), .right-inspector hides/shows as isMobile changes AFTER mount', async () => {
    // This is a documented, deliberate behavioural difference between the
    // arms (see the module header's "WHAT THE COMPONENT MODEL ACTUALLY
    // CHANGED HERE" list) — pinned explicitly here rather than left implicit.
    const { container, isMobile } = mount([makeTool('a')], { isMobileInit: false });
    expect(qs(container, '.right-inspector').hidden).toBe(false);

    isMobile.value = true;
    await flush();
    expect(qs(container, '.right-inspector').hidden).toBe(true);

    isMobile.value = false;
    await flush();
    expect(qs(container, '.right-inspector').hidden).toBe(false);
  });
});

describe('rule 12 — multi-tool exposure', () => {
  it('switching between two tools exposes exactly one .ri-tool-slot at a time; both tool elements keep identity across the switch', async () => {
    const { model, container } = mount([makeTool('a'), makeTool('b')]);

    model.showTool('b');
    await flush();

    const slots = [...container.querySelectorAll('.ri-tool-slot')];
    expect(slots).toHaveLength(2); // both mounted tools stay in the DOM
    const aSlot = qs(container, '.tool-a').closest('.ri-tool-slot') as HTMLElement;
    const bSlot = qs(container, '.tool-b').closest('.ri-tool-slot') as HTMLElement;
    expect(aSlot.hidden).toBe(true); // the other tool stays, but hidden
    expect(bSlot.hidden).toBe(false); // exactly one exposed

    const aBefore = qs(container, '.tool-a');
    const bBefore = qs(container, '.tool-b');
    model.showTool('a'); // switch back — the already-mounted branch
    await flush();

    expect(qs(container, '.tool-a')).toBe(aBefore); // identity preserved
    expect(qs(container, '.tool-b')).toBe(bBefore);
    expect((qs(container, '.tool-a').closest('.ri-tool-slot') as HTMLElement).hidden).toBe(false);
    expect((qs(container, '.tool-b').closest('.ri-tool-slot') as HTMLElement).hidden).toBe(true);
  });

  it('clicking a tab activates the corresponding tool', async () => {
    const { model, container } = mount([makeTool('a'), makeTool('b')]);
    qs<HTMLElement>(container, '[data-tool="b"]').dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(model.activeToolId.value).toBe('b');
  });

  it('moves aria-selected and the active class onto the active tab only', async () => {
    const { model, container } = mount([makeTool('a'), makeTool('b')]);
    model.showTool('b');
    await flush();
    const [a, b] = [...container.querySelectorAll('.ri-tab')] as HTMLElement[];
    expect(a.getAttribute('aria-selected')).toBe('false');
    expect(a.classList.contains('active')).toBe(false);
    expect(b.getAttribute('aria-selected')).toBe('true');
    expect(b.classList.contains('active')).toBe(true);
  });
});

describe('the chevron click and close button wire to setFolded', () => {
  it('clicking the chevron folds, clicking it again unfolds', async () => {
    const { model } = mount([makeTool('a')]);
    model.chevron()!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(model.folded.value).toBe(true);
    model.chevron()!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(model.folded.value).toBe(false);
  });

  it('clicking the close button folds rather than unmounting the active tool', async () => {
    const { model, container } = mount(RIGHT_INSPECTOR_TOOLS);
    qs<HTMLElement>(container, '.ri-close').dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(model.folded.value).toBe(true);
    expect(container.querySelector('.ri-tool-input')).not.toBeNull();
  });
});
