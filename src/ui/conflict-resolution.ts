// The minimal linked-tab conflict resolution chooser (#343 §8). A dirty
// Workbench tab whose linked saved query changed in another browser tab enters
// an explicit `'conflict'` state; ordinary Save is diverted here instead of
// silently overwriting the external version. This module owns only the pure DOM
// of the two-action chooser — the caller (app.ts) anchors it as a popover and
// wires the two resolutions:
//   - "Reload saved version" — discard the local draft, load the latest
//     committed query (fires immediately);
//   - "Keep my draft"        — overwrite the external version with the local
//     draft, but ONLY after an explicit in-chooser confirmation step (the issue
//     requires an explicit confirm before a rebase can clobber the external
//     edit), so this stays a two-stage control.

import { h } from './dom.js';

export interface ConflictChooserHandlers {
  /** The linked query's display name, shown so the user knows what changed. */
  queryName: string;
  /** Discard the local draft and adopt the latest committed query. */
  onReloadSaved: () => void;
  /** Overwrite the external version with the local draft — only invoked after
   *  the in-chooser confirmation step. */
  onKeepDraft: () => void;
}

/** Build the two-action conflict chooser (#343 §8). "Keep my draft" swaps the
 *  action row to an explicit Overwrite/Cancel confirmation before invoking
 *  `onKeepDraft`; "Reload saved version" fires `onReloadSaved` immediately. Pure
 *  DOM — the caller positions/closes it. */
export function buildConflictChooser(handlers: ConflictChooserHandlers): HTMLElement {
  const { queryName, onReloadSaved, onKeepDraft } = handlers;
  const actions = h('div', { class: 'cf-actions' });
  const render = (confirming: boolean): void => {
    if (confirming) {
      actions.replaceChildren(
        h('div', { class: 'cf-confirm' }, 'Overwrite the version saved in the other tab with your draft?'),
        h('div', { class: 'cf-row' },
          h('button', { class: 'cf-cancel', onclick: () => render(false) }, 'Cancel'),
          h('button', { class: 'cf-overwrite', onclick: () => onKeepDraft() }, 'Overwrite')),
      );
    } else {
      actions.replaceChildren(
        h('button', { class: 'cf-reload', onclick: () => onReloadSaved() }, 'Reload saved version'),
        h('button', { class: 'cf-keep', onclick: () => render(true) }, 'Keep my draft'),
      );
    }
  };
  render(false);
  return h('div', { class: 'conflict-chooser' },
    h('div', { class: 'cf-title' }, 'Query changed in another tab'),
    h('div', { class: 'cf-desc' }, '“' + queryName + '” was changed elsewhere and you have unsaved edits here.'),
    actions);
}
