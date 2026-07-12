// The EditorPort seam (#143): the one interface the app talks to the SQL
// editor through. Adapters own the DOM behind it — the textarea adapter today,
// a CodeMirror 6 adapter with #21 — and are injected via `createApp(env)`
// (`env.Editor`, the Chart/Dagre precedent), so swapping editors is a one-line
// change in main.js and app-level tests can run headless on `createNoopPort`.
//
// Contract:
// - Every method tolerates being called before `mount()` (no-op / empty
//   results) — createApp wires the port before renderApp mounts it.
// - `mount()` is re-runnable while the port is live: renderApp resets
//   `app.dom` and re-mounts.
// - `onDocChange(cb)` returns an unsubscribe; `cb` receives the new document
//   text.
// - `destroy()` is TERMINAL: it drops all subscriptions — including the
//   app-level one createApp registers — so a destroyed port must not be
//   re-mounted (typing would repaint but never reach tab.sql again). To swap
//   editors, create a fresh port via `app.Editor(app)` and re-register its
//   consumers; today nothing calls destroy() and the port lives as long as
//   the app.

/**
 * @typedef {Object} EditorPort
 * @property {(container: Element) => void} mount   build the editor UI into `container`
 * @property {() => void} destroy                   TERMINAL — drop all subscriptions; never re-mount a destroyed port
 * @property {() => void} focus
 * @property {() => boolean} hasFocus               the editor input holds document focus (drives the hasSelection signal)
 * @property {() => string} getValue                the full document text
 * @property {() => {start: number, end: number, text: string}} getSelection
 * @property {(text: string) => void} insertAtCursor    replace the selection with `text` (undo-joining)
 * @property {(text: string) => void} replaceDocument   replace the whole document (undo-preserving; equal-value no-op)
 * @property {(pos: number) => void} revealOffset       move the caret to `pos` and scroll its line into view
 * @property {() => void} syncFromState             re-read the active tab into the view (tab switch / bootstrap)
 * @property {() => void} refreshReference          server keyword/function sets changed → re-highlight
 * @property {(cb: (value: string) => void) => (() => void)} onDocChange
 */

/**
 * The do-nothing EditorPort used when `env.Editor` isn't injected (headless
 * app tests). onDocChange callbacks are accepted but never invoked.
 * @returns {EditorPort}
 */
export function createNoopPort() {
  return {
    mount() {},
    destroy() {},
    focus() {},
    hasFocus: () => false,
    getValue: () => '',
    getSelection: () => ({ start: 0, end: 0, text: '' }),
    insertAtCursor() {},
    replaceDocument() {},
    revealOffset() {},
    syncFromState() {},
    refreshReference() {},
    onDocChange: () => () => {},
  };
}
