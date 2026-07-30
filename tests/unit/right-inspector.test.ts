// Tests for #577's vanilla right-inspector CONTROL (state S1).
//
// These hold the behaviour contract the Preact treatment (S2) must reproduce
// exactly — see `src/ui/right-inspector.ts`'s header. The contract, not a line
// target, is what bounds the control: an under-built control biases #577 toward
// "adopt Preact", so every clause below is deliberate.
//
// Held to the repo's real per-file floor (100/95/90/100).

import { describe, it, expect, vi } from 'vitest';
import { mountRightInspector } from '../../src/ui/right-inspector.js';
import type { InspectorTool, RightInspectorApp } from '../../src/ui/right-inspector.js';

const qs = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => root.querySelector(selector) as T;

function makeApp(overrides: Partial<RightInspectorApp['state']> = {}): RightInspectorApp {
  return {
    state: { inspectorPx: 420, isMobile: { value: false }, ...overrides },
    prefs: { save: vi.fn() },
  };
}

/** A tool whose body carries focusable + scrollable + input state, so the
 *  DOM-preservation contract is actually observable rather than assumed. */
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

function mount(tools = [makeTool('a'), makeTool('b')], app = makeApp(), announce?: (m: string) => void) {
  const handle = mountRightInspector({ app, document, tools, announce });
  document.body.appendChild(handle.el);
  return { handle, app };
}

describe('mountRightInspector — structure', () => {
  it('composes the shared drawer chrome under its own ri-* prefix', () => {
    const { handle } = mount();
    // Reusing buildDrawerChrome rather than hand-rolling the panel is the whole
    // point of the control: it is what the repo would actually do.
    const panel = qs(handle.el, '.ri-panel');
    expect(panel).not.toBeNull();
    expect(qs(panel, '.ri-head')).not.toBeNull();
    expect(qs(panel, '.ri-title')).not.toBeNull();
    expect(qs(panel, '.ri-close')).not.toBeNull();
    expect(qs(panel, '.ri-body')).not.toBeNull();
  });

  it('applies the persisted width through the shared bounded resize primitive', () => {
    const { handle } = mount([makeTool('a')], makeApp({ inspectorPx: 500 }));
    // clampDrawerWidth's floor is 320 and happy-dom reports a real innerWidth,
    // so this asserts the primitive ran, not a raw assignment.
    expect(qs(handle.el, '.ri-panel').style.width).toMatch(/px$/);
    expect(qs(handle.el, '.ri-resize-h, .cd-resize-h')).not.toBeNull();
  });

  it('renders one tab per tool, in order', () => {
    const { handle } = mount([makeTool('a', 'Alpha'), makeTool('b', 'Beta')]);
    const tabs = [...handle.el.querySelectorAll('.ri-tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Alpha', 'Beta']);
    expect(tabs.map((t) => (t as HTMLElement).dataset.tool)).toEqual(['a', 'b']);
  });

  it('mounts and exposes the first tool immediately, never an empty box', () => {
    // #487 phase 3 shipped exactly this bug for the History section — a section
    // that was not active at mount never got its first paint.
    const { handle } = mount();
    expect(handle.activeToolId()).toBe('a');
    const body = qs(handle.el, '.ri-body');
    expect(body.children).toHaveLength(1);
    expect(qs<HTMLElement>(body, '.tool-a').hidden).toBe(false);
  });

  it('hides the whole pane at a mobile viewport', () => {
    const { handle } = mount([makeTool('a')], makeApp({ isMobile: { value: true } }));
    expect(handle.el.hidden).toBe(true);
  });

  it('shows the pane at a desktop viewport', () => {
    expect(mount().handle.el.hidden).toBe(false);
  });

  it('tolerates an empty tool list without throwing', () => {
    const { handle } = mount([]);
    expect(handle.activeToolId()).toBeNull();
    expect(handle.el.querySelectorAll('.ri-tab')).toHaveLength(0);
  });
});

describe('tool switching', () => {
  it('mounts a tool lazily on first activation', () => {
    const { handle } = mount();
    const body = qs(handle.el, '.ri-body');
    expect(body.children).toHaveLength(1);
    handle.showTool('b');
    expect(body.children).toHaveLength(2);
    expect(handle.activeToolId()).toBe('b');
  });

  it('exposes exactly one tool at a time', () => {
    const { handle } = mount();
    handle.showTool('b');
    expect(qs<HTMLElement>(handle.el, '.tool-a').hidden).toBe(true);
    expect(qs<HTMLElement>(handle.el, '.tool-b').hidden).toBe(false);
  });

  it('switches in place, preserving the inactive tool node and its state', () => {
    // The contract nav-sections.ts exists to guarantee on the left, asserted
    // here for the right: a switch is a re-presentation, never a rebuild.
    const { handle } = mount();
    const aBefore = qs(handle.el, '.tool-a');
    qs<HTMLInputElement>(handle.el, '.input-a').value = 'typed';
    handle.showTool('b');
    handle.showTool('a');
    expect(qs(handle.el, '.tool-a')).toBe(aBefore);
    expect(qs<HTMLInputElement>(handle.el, '.input-a').value).toBe('typed');
  });

  it('moves aria-selected onto the active tab only', () => {
    const { handle } = mount();
    handle.showTool('b');
    const [a, b] = [...handle.el.querySelectorAll('.ri-tab')] as HTMLElement[];
    expect(a.getAttribute('aria-selected')).toBe('false');
    expect(b.getAttribute('aria-selected')).toBe('true');
    expect(b.classList.contains('active')).toBe(true);
  });

  it('activates a tool when its tab is clicked', () => {
    const { handle } = mount();
    qs<HTMLElement>(handle.el, '[data-tool="b"]').dispatchEvent(new Event('click', { bubbles: true }));
    expect(handle.activeToolId()).toBe('b');
  });

  it('ignores an unknown tool id rather than blanking the pane', () => {
    const { handle } = mount();
    handle.showTool('nope');
    expect(handle.activeToolId()).toBe('a');
    expect(qs<HTMLElement>(handle.el, '.tool-a').hidden).toBe(false);
  });

  it('treats selecting a tool in a folded pane as a reveal', () => {
    // Otherwise the click appears to do nothing at all.
    const { handle } = mount();
    handle.setFolded(true);
    handle.showTool('b');
    expect(handle.folded()).toBe(false);
    expect(handle.activeToolId()).toBe('b');
  });
});

describe('the chevron fold', () => {
  it('starts expanded, with the chevron labelled for collapsing', () => {
    const { handle } = mount();
    expect(handle.folded()).toBe(false);
    expect(qs(handle.el, '.ri-panel').dataset.folded).toBe('false');
    expect(handle.chevron.getAttribute('aria-expanded')).toBe('true');
    expect(handle.chevron.getAttribute('aria-label')).toBe('Collapse inspector');
  });

  it('folds on chevron click and flips every affordance together', () => {
    const { handle } = mount();
    handle.chevron.dispatchEvent(new Event('click', { bubbles: true }));
    expect(handle.folded()).toBe(true);
    expect(qs(handle.el, '.ri-panel').dataset.folded).toBe('true');
    expect(qs<HTMLElement>(handle.el, '.ri-body').hidden).toBe(true);
    expect(qs<HTMLElement>(handle.el, '.ri-tabs').hidden).toBe(true);
    expect(handle.chevron.getAttribute('aria-expanded')).toBe('false');
    expect(handle.chevron.getAttribute('aria-label')).toBe('Expand inspector');
    expect(handle.chevron.title).toBe('Expand inspector');
  });

  it('unfolds on a second chevron click', () => {
    const { handle } = mount();
    handle.chevron.dispatchEvent(new Event('click', { bubbles: true }));
    handle.chevron.dispatchEvent(new Event('click', { bubbles: true }));
    expect(handle.folded()).toBe(false);
    expect(qs<HTMLElement>(handle.el, '.ri-body').hidden).toBe(false);
  });

  it('folds via the shared close button rather than unmounting', () => {
    // A persistent non-modal pane (the doc-pane.ts precedent) has no caller
    // waiting to tear it down, and a close that destroyed tool state would break
    // the preservation contract.
    const { handle } = mount();
    qs<HTMLElement>(handle.el, '.ri-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(handle.folded()).toBe(true);
    expect(qs(handle.el, '.tool-a')).not.toBeNull();
  });

  it('is idempotent in both directions', () => {
    const { handle } = mount([makeTool('a')], makeApp(), vi.fn());
    handle.setFolded(false);
    expect(handle.folded()).toBe(false);
    handle.setFolded(true);
    handle.setFolded(true);
    expect(handle.folded()).toBe(true);
  });

  it('swaps the chevron glyph to point the way the pane will move', () => {
    const { handle } = mount();
    const before = handle.chevron.firstElementChild;
    handle.setFolded(true);
    expect(handle.chevron.firstElementChild).not.toBe(before);
    expect(handle.chevron.children).toHaveLength(1);
  });

  it('preserves the active tool node, its input value and its scroll across a fold round trip', () => {
    const { handle } = mount();
    const toolBefore = qs(handle.el, '.tool-a');
    const input = qs<HTMLInputElement>(handle.el, '.input-a');
    input.value = 'survives';
    toolBefore.scrollTop = 40;
    handle.setFolded(true);
    handle.setFolded(false);
    expect(qs(handle.el, '.tool-a')).toBe(toolBefore);
    expect(qs<HTMLInputElement>(handle.el, '.input-a').value).toBe('survives');
    expect(qs(handle.el, '.tool-a').scrollTop).toBe(40);
  });

  it('announces both fold directions through the injected seam', () => {
    const announce = vi.fn();
    const { handle } = mount([makeTool('a')], makeApp(), announce);
    handle.setFolded(true);
    handle.setFolded(false);
    expect(announce.mock.calls.map((c) => c[0])).toEqual(['Inspector collapsed', 'Inspector expanded']);
  });

  it('works with no announce seam supplied', () => {
    const { handle } = mount();
    expect(() => handle.setFolded(true)).not.toThrow();
  });
});

describe('focus settlement', () => {
  it('lands focus on the chevron when the fold hides the focused control', () => {
    // The one contract #577 names for both edges: never `<body>`, never a
    // control the transition just hid. The chevron is the only element visible
    // in both states, which is what makes it the correct destination.
    const { handle } = mount();
    const input = qs<HTMLInputElement>(handle.el, '.input-a');
    input.focus();
    expect(document.activeElement).toBe(input);
    handle.setFolded(true);
    expect(document.activeElement).toBe(handle.chevron);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('does not steal focus that was never inside the pane', () => {
    const { handle } = mount();
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    handle.setFolded(true);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('leaves focus alone on unfold', () => {
    // Unfold hides nothing, so there is nothing to rescue — moving focus here
    // would be the "do not steal a newer user focus" failure.
    const { handle } = mount();
    handle.setFolded(true);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    handle.setFolded(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('does not move focus when the fold is a no-op', () => {
    const { handle } = mount();
    const input = qs<HTMLInputElement>(handle.el, '.input-a');
    input.focus();
    handle.setFolded(false);
    expect(document.activeElement).toBe(input);
  });
});

describe('resize lifecycle', () => {
  /** Start a real resize drag on the shared handle, leaving the pointer down. */
  function startDrag(handle: { el: HTMLElement }): void {
    const grip = qs<HTMLElement>(handle.el, '.cd-resize-h');
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 900 }));
  }

  it('persists a width through the shared primitive on drag end', () => {
    const { handle, app } = mount();
    startDrag(handle);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.prefs.save).toHaveBeenCalledWith('inspectorPx', expect.any(Number));
  });

  it('writes the inspector key, never the docs pane or cell drawer key', () => {
    // The whole reason splitters.ts got a third axis instead of sharing
    // 'docPane': two panes that can be open at once must not clobber each
    // other's persisted width.
    const { handle, app } = mount();
    startDrag(handle);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    const keys = (app.prefs.save as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(keys).toEqual(['inspectorPx']);
    expect(app.state.docPanePx).toBeUndefined();
    expect(app.state.cellDrawerPx).toBeUndefined();
  });

  it('cancels a live drag when the pane folds mid-gesture', () => {
    // Without this the abandoned drag's trailing mouseup persists a width for a
    // pane that is no longer showing.
    const { handle, app } = mount();
    startDrag(handle);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    handle.setFolded(true);
    (app.prefs.save as ReturnType<typeof vi.fn>).mockClear();
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.prefs.save).not.toHaveBeenCalled();
  });

  it('restores the pre-drag width when a fold cancels the gesture', () => {
    const { handle, app } = mount([makeTool('a')], makeApp({ inspectorPx: 420 }));
    startDrag(handle);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    handle.setFolded(true);
    expect(app.state.inspectorPx).toBe(420);
  });

  it('cancels a live drag on dispose', () => {
    const { handle, app } = mount();
    startDrag(handle);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    handle.dispose();
    (app.prefs.save as ReturnType<typeof vi.fn>).mockClear();
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.prefs.save).not.toHaveBeenCalled();
  });

  it('does not cancel anything when disposing with no drag in progress', () => {
    const { handle } = mount();
    expect(() => handle.dispose()).not.toThrow();
  });

  it('releases retained tool nodes on dispose', () => {
    const { handle } = mount();
    handle.showTool('b');
    handle.dispose();
    // The retained map is what would otherwise keep every mounted tool's DOM
    // (and anything it closes over) alive past teardown.
    handle.showTool('a');
    expect(handle.el.querySelectorAll('.tool-a')).toHaveLength(2);
  });
});
