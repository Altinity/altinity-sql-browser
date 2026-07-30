// #577 state S2 (Preact treatment) — the right inspector as a component.
//
// This is the treatment-arm counterpart of S1's `ui/right-inspector.ts`, and it
// implements the SAME contract, because the S1→S2 delta is the evaluation's
// only architectural comparison and a feature difference would corrupt it:
//
//   - folding must not discard the active tool's DOM (identity, scroll and any
//     input value survive a fold/unfold round trip — the pane is re-presented,
//     never rebuilt);
//   - focus must settle on a semantic destination: focus inside the pane when
//     it folds lands on the chevron, never on `<body>`, never on a control the
//     fold just hid;
//   - a fold while a resize drag is live must cancel that drag, or its trailing
//     `mouseup` persists a width for a pane that is no longer showing;
//   - `dispose()` must leave nothing behind, including mid-drag.
//
// WHAT THE COMPONENT MODEL ACTUALLY CHANGED HERE, stated so the report can
// count it rather than assert it:
//
//   + The eight-property `setFolded` write-block (dataset, two `hidden`s, three
//     chevron attributes, a `replaceChildren` on a live SVG, then a loop over
//     every tab and every mounted tool) becomes rendered output. That is the
//     largest single reduction in the arm.
//   + `renderActive()` disappears entirely: "exactly one tool exposed" is a
//     property of the render, not a function someone must remember to call.
//   − A tool's element is FOREIGN DOM (a tool mounts itself), so Preact cannot
//     put `hidden` on it. Each tool gains a `.ri-tool-slot` wrapper — one extra
//     element and one extra CSS rule per preserved-but-hidden child — laid out
//     with `display: contents` so the rendered box tree still matches S1's
//     exactly. This is a real cost of the vDOM boundary and is reported as one.
//   − `drawer.ts`'s `attachDrawerResize` cannot be reused: it APPENDS its handle
//     into the panel imperatively, and this arm's own constraint is that vanilla
//     code and Preact never mutate the same subtree. The handle is therefore
//     rendered declaratively and drives `splitters.startDrag` directly — a
//     composition loss the vanilla arm does not pay.
//   ~ `hidden` for the mobile projection is genuinely reactive here, where S1
//     reads `isMobile` untracked once at mount and relies on the caller to
//     re-mount. That is a small behavioural IMPROVEMENT the component arm gets
//     for free, and the report must not also count it as a line saving.

import { h as ph } from 'preact';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals-core';
import { h, withDocument } from '../dom.js';
import { Icon } from '../icons.js';
import { startDrag, clampDrawerWidth } from '../splitters.js';
import { adopt, adoptOne } from './adopt.js';
import { createFocusSettler } from './focus-settlement.js';
import type { FocusSettler } from './focus-settlement.js';
import type { PreferenceKey } from '../../application/app-preferences.js';

/** One tool the inspector can host. `mount` is called ONCE, lazily, the first
 *  time the tool becomes active; the element it returns is retained and
 *  re-presented across folds, which is what makes DOM preservation testable
 *  rather than aspirational. Identical to S1's own `InspectorTool`. */
export interface InspectorTool {
  id: string;
  label: string;
  mount(doc: Document): HTMLElement;
}

/**
 * The ONE mock tool #577's evaluation scope item 4 asks for. Carried over from
 * the S1 control byte-for-byte in intent: deliberately mock, deliberately only
 * one, and deliberately holding state (a focusable input, a scrollable body)
 * that a fold could destroy — a tool with no state would make the preservation
 * tests vacuous. #488 decides what the real tools are; pre-empting that here
 * would start the implementation #577 lists as a non-goal.
 */
export const RIGHT_INSPECTOR_TOOLS: InspectorTool[] = [
  {
    id: 'detail',
    label: 'Detail',
    mount: (doc) => withDocument(doc, () => h('div', { class: 'ri-tool' },
      h('div', { class: 'ri-tool-note' }, 'Inspector placeholder (#577 evaluation slice).'),
      h('input', { class: 'ri-tool-input', type: 'text', placeholder: 'Scratch value' }))),
  },
];

/** The narrow app surface this pane needs — structurally a subset of the real
 *  `App`, so a plain fixture satisfies it without a full `createApp`. */
export interface InspectorApp {
  state: { inspectorPx?: number; isMobile: Signal<boolean> };
  prefs: { save(name: PreferenceKey, value: unknown): void };
}

export interface InspectorModelDeps {
  app: InspectorApp;
  document: Document;
  tools: InspectorTool[];
  /** Announce fold-state changes through the caller's live region, mirroring
   *  the left separator's `announce` seam so both shell edges are equally
   *  screen-reader legible. Omitted: nothing announces, nothing throws. */
  announce?: (message: string) => void;
  /** The window whose `innerWidth` bounds the resize, and which the drag
   *  listens on. Defaults to `document.defaultView` or the ambient window —
   *  the same fallback `drawer.ts` uses for a synthetic test document. */
  win?: Window;
}

/**
 * The inspector's state and commands, owned OUTSIDE the component.
 *
 * Why not hooks: the shell's public `AppShellHandle` has to be able to dispose
 * the pane and expose its root element on `app.dom`, and the pane's own tool
 * DOM has to outlive any particular render. State that outlives the component
 * belongs beside the component, not inside it — the same rule this repo already
 * applies to editors and graphs.
 */
export interface InspectorModel {
  readonly folded: Signal<boolean>;
  readonly activeToolId: Signal<string | null>;
  readonly widthPx: Signal<number>;
  /** The `.right-inspector` root, once rendered. `null` before the first
   *  render — which never happens in practice, because Preact's first render is
   *  synchronous. */
  el(): HTMLElement | null;
  /** The chevron — the documented focus destination for a fold, exposed so a
   *  test can assert focus landed there without a class selector. */
  chevron(): HTMLButtonElement | null;
  setFolded(folded: boolean): void;
  /** Expose one tool by id. A no-op for an unknown id, so a stale caller cannot
   *  blank the pane. */
  showTool(id: string): void;
  dispose(): void;
  /** @internal — the view's own wiring. */
  readonly internals: InspectorInternals;
}

/** The parts the view needs and nothing else needs. Grouped rather than spread
 *  across the public surface so the handle above stays the caller's contract. */
export interface InspectorInternals {
  tools: InspectorTool[];
  settler: FocusSettler;
  toolElement(id: string): HTMLElement | null;
  setRoot(el: HTMLElement | null): void;
  setChevron(el: HTMLButtonElement | null): void;
  beginResize(ev: MouseEvent): void;
  isMobile(): boolean;
}

export function createInspectorModel(deps: InspectorModelDeps): InspectorModel {
  const { app, document: doc, tools, announce } = deps;
  const win = deps.win || doc.defaultView || window;
  const folded = signal(false);
  const activeToolId = signal<string | null>(tools.length > 0 ? tools[0].id : null);
  const widthPx = signal(clampDrawerWidth(app.state.inspectorPx ?? 0, win.innerWidth));
  // Lazily-mounted tool bodies, retained by id. This map IS the DOM-preservation
  // contract: a fold re-presents the host, it never clears this map, so an
  // unfold shows the exact same nodes with their scroll and input state intact.
  const mounted = new Map<string, HTMLElement>();
  const settler = createFocusSettler(doc);
  let root: HTMLElement | null = null;
  let chevron: HTMLButtonElement | null = null;
  let cancelActiveResize: (() => void) | null = null;

  const cancelResize = (): void => {
    if (cancelActiveResize === null) return;
    cancelActiveResize();
    cancelActiveResize = null;
  };

  function setFolded(next: boolean): void {
    if (next === folded.value) return;
    // Captured BEFORE the state write, which is the only moment at which the
    // pre-transition DOM is still guaranteed to exist — Preact offers no
    // "before the diff" hook (see `focus-settlement.ts`'s header).
    settler.capture(root);
    // A fold can land while a resize drag is still live (pointer still down).
    // Without this the abandoned drag's trailing `mouseup` persists a width for
    // a pane that is no longer showing.
    if (next) cancelResize();
    folded.value = next;
    announce?.(next ? 'Inspector collapsed' : 'Inspector expanded');
  }

  function showTool(id: string): void {
    const tool = tools.find((candidate) => candidate.id === id);
    // Unknown id: leave the pane exactly as it is rather than blanking it.
    if (!tool) return;
    if (!mounted.has(id)) mounted.set(id, tool.mount(doc));
    activeToolId.value = id;
    // Selecting a tool in a folded pane is a reveal, not just a switch —
    // otherwise the click appears to do nothing.
    if (folded.value) setFolded(false);
  }

  // First paint: mount and expose the initial tool so the pane is never an
  // empty box waiting for a click.
  const initialTool = activeToolId.value;
  if (initialTool !== null) showTool(initialTool);

  return {
    folded,
    activeToolId,
    widthPx,
    el: () => root,
    chevron: () => chevron,
    setFolded,
    showTool,
    dispose: () => {
      // Mid-drag teardown: same reason as the fold path.
      cancelResize();
      settler.cancel();
      mounted.clear();
    },
    internals: {
      tools,
      settler,
      toolElement: (id) => mounted.get(id) || null,
      setRoot: (el) => { root = el; },
      setChevron: (el) => { chevron = el; },
      isMobile: () => app.state.isMobile.value,
      beginResize: (ev) => {
        const startPx = widthPx.value;
        const stop = startDrag(
          { preventDefault: () => ev.preventDefault(), currentTarget: ev.currentTarget as Element },
          'inspector',
          {
            win,
            state: app.state,
            rectFor: () => ({ width: win.innerWidth }),
            // The one line that differs from `drawer.ts`'s shared primitive:
            // the width is state, not a style write, so the pane's own render
            // owns it and no vanilla code reaches into a Preact-owned element.
            apply: (_axis, value) => { widthPx.value = value; },
            save: (name, value) => app.prefs.save(name as PreferenceKey, value),
          },
        );
        cancelActiveResize = () => { stop(); widthPx.value = startPx; };
      },
    },
  };
}

/** The rendered pane. Every attribute S1 wrote by hand in `setFolded` is an
 *  expression here, and "exactly one tool exposed" is structural. */
export function InspectorView(props: { model: InspectorModel }): ComponentChildren {
  const { model } = props;
  const { internals } = model;
  const isFolded = model.folded.value;
  const activeId = model.activeToolId.value;

  // Settle focus AFTER the destination is rendered — a layout effect runs once
  // the diff is applied and before the browser paints, which is exactly the
  // "after the destination exists, before the user can see the wrong thing"
  // window the contract asks for. The chevron is the one control visible in
  // BOTH states, which is what makes it the correct semantic destination.
  useLayoutEffect(() => {
    internals.settler.settle(() => model.chevron());
  }, [isFolded]);

  const label = isFolded ? 'Expand inspector' : 'Collapse inspector';
  return ph('div', {
    class: 'right-inspector',
    hidden: internals.isMobile(),
    ref: internals.setRoot,
  }, ph('div', {
    class: 'ri-panel',
    'data-folded': isFolded ? 'true' : 'false',
    style: { width: model.widthPx.value + 'px' },
  },
  ph('div', { class: 'ri-head' },
    ph('div', { class: 'ri-title' },
      ph('button', {
        class: 'ri-chevron',
        'aria-expanded': isFolded ? 'false' : 'true',
        'aria-label': label,
        title: label,
        // The glyph points the way the pane will move: right collapses it
        // toward the edge, left brings it back. S1 did this with
        // `replaceChildren` on a live SVG node. Here the BUTTON is the adopted
        // element — one ref doing both jobs, so the rendered DOM stays exactly
        // `button > svg` with no wrapper span (and no new class needing a CSS
        // rule) that a vDOM would otherwise force.
        ref: (el: HTMLButtonElement | null) => {
          internals.setChevron(el);
          adoptOne(isFolded ? Icon.chevLeft() : Icon.chev())(el);
        },
        onClick: () => { model.setFolded(!isFolded); },
      }),
      ph('div', { class: 'ri-tabs', role: 'tablist', hidden: isFolded },
        ...internals.tools.map((tool) => ph('button', {
          class: 'ri-tab' + (tool.id === activeId && !isFolded ? ' active' : ''),
          role: 'tab',
          'data-tool': tool.id,
          'aria-selected': tool.id === activeId && !isFolded ? 'true' : 'false',
          onClick: () => { model.showTool(tool.id); },
        }, tool.label)))),
    // The close button folds rather than unmounting: this is a persistent,
    // non-modal pane, so there is no caller waiting to tear it down and a
    // "close" that destroyed the tool state would break the preservation
    // contract above.
    ph('button', {
      class: 'ri-close', title: 'Close (Esc)', onClick: () => { model.setFolded(true); },
      ref: adopt(Icon.close()),
    })),
  ph('div', { class: 'ri-body', hidden: isFolded },
    // One slot per MOUNTED tool. `display: contents` keeps the rendered box
    // tree identical to S1's, where the tool element was `.ri-body`'s direct
    // child — the slot exists only because Preact may not write `hidden` onto
    // foreign DOM it does not own.
    ...internals.tools
      .map((tool) => ({ tool, el: internals.toolElement(tool.id) }))
      .filter((entry): entry is { tool: InspectorTool; el: HTMLElement } => entry.el !== null)
      .map((entry) => ph('div', {
        class: 'ri-tool-slot', hidden: entry.tool.id !== activeId, ref: adopt(entry.el),
      }))),
  ph('div', {
    class: 'cd-resize-h', title: 'Drag to resize',
    onMouseDown: (ev: MouseEvent) => { internals.beginResize(ev); },
  })));
}
