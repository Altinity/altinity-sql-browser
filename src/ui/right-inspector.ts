// The right inspector — #577's VANILLA CONTROL (state S1), not a product
// feature.
//
// WHY THIS EXISTS. #577 asks whether Preact would make this application
// materially simpler, and its evaluation scope requires the comparison to cover
// "a minimal right-inspector host with chevron, resize boundary, and one mock
// tool" (item 4) as well as the existing left navigation. #488 will build the
// real thing ("Unify cell detail, rows and documentation in a foldable desktop
// right inspector") and is explicitly a NON-GOAL here. But the issue also
// forbids comparing "an incomplete Preact prototype against the full production
// behavior" — so the Preact arm cannot be the only arm that implements the
// inspector. This module is the control it is measured against: what the NEXT
// shell feature costs under the current architecture.
//
// It is therefore built the way this repo would actually build it — by
// composing the primitives that already exist — and NOT greenfield. An
// over-built control inflates the vanilla baseline and biases the whole
// evaluation toward "adopt Preact":
//   - `buildDrawerChrome` (drawer.ts) already yields panel/head/title/close;
//   - `attachDrawerResize` (drawer.ts) already wires a bounded, persisted,
//     right-edge-anchored resize drag through `startDrag`;
//   - `splitters.ts`'s 'inspector' axis + `inspectorPx` mirror the 'docPane'
//     pair #313 added, so this pane never clobbers the docs pane's width.
// The only genuinely new behaviour here is the CHEVRON FOLD and the focus/DOM
// preservation contract around it.
//
// The fold contract mirrors what #487 phase 3 had to get right on the left, and
// is the reason the inspector is in the slice at all — it is the same
// structural-transition-with-disappearing-focus problem on the other edge:
//   - folding must not discard the active tool's DOM (identity, scroll, and any
//     input value survive a fold/unfold round trip — the pane is re-presented,
//     never rebuilt);
//   - focus must settle on a semantic destination. If focus is inside the pane
//     when it folds, it lands on the chevron — never on `<body>`, and never on
//     a control the fold just hid;
//   - a fold while a resize drag is still live must cancel that drag, or its
//     trailing `mouseup` persists a width for a pane that is no longer showing;
//   - `dispose()` must leave nothing behind, including mid-drag.

import { h, withDocument } from './dom.js';
import { Icon } from './icons.js';
import { buildDrawerChrome, attachDrawerResize } from './drawer.js';
import type { DrawerResizeApp } from './drawer.js';

/** The narrow app surface this pane needs — structurally a subset of the real
 *  `App`, so a plain test fixture satisfies it without a full `createApp`.
 *  `state.isMobile` is read (not subscribed) for the desktop/mobile projection:
 *  a phone gets no persistent side pane, matching how `.sidebar` behaves. */
export interface RightInspectorApp extends DrawerResizeApp {
  state: {
    cellDrawerPx?: number;
    docPanePx?: number;
    inspectorPx?: number;
    isMobile: { value: boolean };
  };
  prefs: DrawerResizeApp['prefs'];
}

/** One tool the inspector can host. `mount` is called ONCE, lazily, the first
 *  time the tool becomes active; the element it returns is retained and
 *  re-presented across folds, which is what makes DOM preservation testable
 *  rather than aspirational. */
export interface InspectorTool {
  id: string;
  label: string;
  mount(doc: Document): HTMLElement;
}

export interface RightInspectorOptions {
  app: RightInspectorApp;
  document: Document;
  tools: InspectorTool[];
  /** Announce fold state changes through the caller's live region, mirroring
   *  the left separator's `announce` seam so both edges are equally
   *  screen-reader legible. Optional: omitted, nothing announces and nothing
   *  throws — the same "feature simply doesn't run" contract `matchMedia: null`
   *  already has in app-shell.ts. */
  announce?: (message: string) => void;
}

export interface RightInspectorHandle {
  /** The pane element the caller mounts into `.main-row`. */
  el: HTMLElement;
  /** The chevron — exposed because it is the documented focus destination for a
   *  fold, so a test can assert focus landed there without a class selector. */
  chevron: HTMLButtonElement;
  /** Fold or unfold. Idempotent. */
  setFolded(folded: boolean): void;
  folded(): boolean;
  /** Expose one tool by id. A no-op for an unknown id, so a stale caller cannot
   *  blank the pane. */
  showTool(id: string): void;
  activeToolId(): string | null;
  dispose(): void;
}

/**
 * The ONE mock tool #577's evaluation scope item 4 asks for ("a minimal
 * right-inspector host with chevron, resize boundary, and one mock tool").
 *
 * Deliberately mock, and deliberately only one. #488 will decide what the real
 * tools are (it unifies cell detail, rows and documentation); pre-empting that
 * here would start the implementation this issue lists as a non-goal. What the
 * comparison needs from a tool is only that it HOLD STATE a fold could destroy —
 * hence the focusable input and the scrollable body.
 */
export const RIGHT_INSPECTOR_TOOLS: InspectorTool[] = [
  {
    id: 'detail',
    label: 'Detail',
    mount: (doc) => withDocument(doc, () => h('div', { class: 'ri-tool' },
      h('div', { class: 'ri-tool-note' }, 'Inspector placeholder (#577 evaluation slice).'),
      // A real focus target and a real scroll container: the fold contract is
      // about preserving exactly this kind of state, so a tool with none would
      // make the preservation tests vacuous.
      h('input', { class: 'ri-tool-input', type: 'text', placeholder: 'Scratch value' }))),
  },
];

/**
 * Build and mount the right inspector. Returns the handle above; the caller
 * owns placement and teardown.
 */
export function mountRightInspector(opts: RightInspectorOptions): RightInspectorHandle {
  const { app, document: doc, tools, announce } = opts;
  const state = app.state;

  return withDocument(doc, () => {
    let isFolded = false;
    let activeId: string | null = tools.length > 0 ? tools[0].id : null;
    // Lazily-mounted tool bodies, retained by id. This map IS the DOM-preservation
    // contract: a fold hides the host, it never clears this map, so an unfold
    // re-presents the exact same nodes with their scroll and input state intact.
    const mounted = new Map<string, HTMLElement>();

    const body = h('div', { class: 'ri-body' });
    const chevron: HTMLButtonElement = h('button', {
      class: 'ri-chevron',
      'aria-expanded': 'true',
      'aria-label': 'Collapse inspector',
      title: 'Collapse inspector',
      onclick: () => { setFolded(!isFolded); },
    }, Icon.chev());

    // The tool switcher. Built once; only the `aria-selected`/active class move,
    // so a switch is never a rebuild.
    const tabs = h('div', { class: 'ri-tabs', role: 'tablist' });
    const tabButtons = new Map<string, HTMLElement>();
    for (const tool of tools) {
      const button = h('button', {
        class: 'ri-tab',
        role: 'tab',
        'data-tool': tool.id,
        'aria-selected': 'false',
        onclick: () => { showTool(tool.id); },
      }, tool.label);
      tabButtons.set(tool.id, button);
      tabs.appendChild(button);
    }

    const chrome = buildDrawerChrome(doc, {
      classPrefix: 'ri',
      title: [chevron, tabs],
      // The close button folds rather than unmounting: this is a persistent,
      // non-modal pane (the `doc-pane.ts` precedent), so there is no caller
      // waiting to tear it down and a "close" that destroyed the tool state
      // would break the preservation contract above.
      onClose: () => { setFolded(true); },
    });
    const panel = chrome.panel;
    panel.appendChild(body);

    // Bounded, persisted resize over the shared primitive. `cancelResize()` is
    // what makes a fold-mid-drag safe.
    const cancelResize = attachDrawerResize(app, panel, doc, {
      stateKey: 'inspectorPx', axis: 'inspector',
    });

    function renderActive(): void {
      for (const [id, button] of tabButtons) {
        const selected = id === activeId && !isFolded;
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
        button.classList.toggle('active', selected);
      }
      // Expose exactly one tool host; every other stays in `mounted` untouched.
      for (const [id, el] of mounted) el.hidden = id !== activeId;
    }

    function showTool(id: string): void {
      const tool = tools.find((t) => t.id === id);
      // Unknown id: leave the pane exactly as it is rather than blanking it.
      if (!tool) return;
      activeId = id;
      if (!mounted.has(id)) {
        const el = tool.mount(doc);
        mounted.set(id, el);
        body.appendChild(el);
      }
      // Selecting a tool in a folded pane is a reveal, not just a switch —
      // otherwise the click appears to do nothing.
      if (isFolded) setFolded(false);
      else renderActive();
    }

    function setFolded(folded: boolean): void {
      if (folded === isFolded) return;
      // Captured BEFORE any hidden/attribute write, for the same reason
      // app-shell.ts captures it before its own presentation writes: once an
      // ancestor is hidden the browser drops the focused descendant to `<body>`
      // on its own by the next microtask unless something moves it first.
      const activeBefore = doc.activeElement;
      const focusWasInside = activeBefore instanceof Element && panel.contains(activeBefore);

      if (folded) {
        // A fold can land while a resize drag is still live (pointer still
        // down). Without this the abandoned drag's trailing `mouseup` persists a
        // width for a pane that is no longer showing.
        cancelResize();
      }
      isFolded = folded;
      panel.dataset.folded = folded ? 'true' : 'false';
      body.hidden = folded;
      tabs.hidden = folded;
      chevron.setAttribute('aria-expanded', folded ? 'false' : 'true');
      const label = folded ? 'Expand inspector' : 'Collapse inspector';
      chevron.setAttribute('aria-label', label);
      chevron.title = label;
      // The glyph points the way the pane will move: right collapses it toward
      // the edge, left brings it back. `replaceChildren` on a live SVG node is
      // exactly the kind of imperative mutation this control exists to measure.
      chevron.replaceChildren(folded ? Icon.chevLeft() : Icon.chev());
      renderActive();

      // The chevron is the one control that is visible in BOTH states, which is
      // exactly what makes it the correct semantic destination. Only rescue
      // focus that was actually inside the pane — stealing it otherwise would
      // break whatever the user was really doing.
      if (folded && focusWasInside) chevron.focus();
      announce?.(folded ? 'Inspector collapsed' : 'Inspector expanded');
    }

    const el = h('div', {
      class: 'right-inspector',
      // Mobile gets no persistent side pane, matching `.sidebar`'s own mobile
      // rules. Read untracked (a plain read, no effect here) — the caller
      // re-mounts or re-projects on a breakpoint change, exactly as the shell
      // already does for the left navigation.
      hidden: state.isMobile.value,
    }, panel);
    panel.dataset.folded = 'false';

    // First paint: mount and expose the initial tool so the pane is never an
    // empty box waiting for a click (the same bug #487 phase 3 fixed for the
    // History section, which had no initial paint at all).
    if (activeId !== null) showTool(activeId);

    return {
      el,
      chevron,
      setFolded,
      folded: () => isFolded,
      showTool,
      activeToolId: () => activeId,
      dispose: () => {
        // Mid-drag teardown: same reason as the fold path.
        cancelResize();
        mounted.clear();
      },
    };
  });
}
