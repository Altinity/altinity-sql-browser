// Phase-0 typed contract for the EditorPort seam (#143, ADR-0002 phase 0 /
// #262). Declares the shape `src/editor/editor-port.js` already implements
// (createNoopPort) and every real adapter (CodeMirror 6, #21) must match — no
// behavior change, the runtime module stays untouched `.js`. Its own JSDoc
// `@typedef` points here (`import('./editor-port.types.js').EditorPort`) so
// there is a single source of truth for this contract.

export interface EditorSelection {
  start: number;
  end: number;
  text: string;
}

export interface EditorPort {
  /** Build the editor UI into `container`. */
  mount(container: Element): void;
  /** TERMINAL — drops all subscriptions; never re-mount a destroyed port. */
  destroy(): void;
  focus(): void;
  /** The editor input holds document focus (drives the hasSelection signal). */
  hasFocus(): boolean;
  /** The full document text. */
  getValue(): string;
  getSelection(): EditorSelection;
  /** Replace the selection with `text` (undo-joining). */
  insertAtCursor(text: string): void;
  /** Replace the whole document (undo-preserving; equal-value no-op). */
  replaceDocument(text: string): void;
  /** Move the caret to `pos` and scroll its line into view. */
  revealOffset(pos: number): void;
  /** Re-read the active tab into the view (tab switch / bootstrap). */
  syncFromState(): void;
  /** Server keyword/function sets changed — re-highlight. */
  refreshReference(): void;
  onDocChange(cb: (value: string) => void): () => void;
}
