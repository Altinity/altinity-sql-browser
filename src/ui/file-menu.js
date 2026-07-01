// The header "File ▾" menu: the saved-query collection treated as a savable
// document ("the Library"). New / Save (JSON) / Open (replace) / Append, plus one-way
// Markdown/SQL "share" downloads, an editable library name, and an
// unsaved-changes dot. Render module over the `app` controller; every side
// effect goes through an injected seam (app.saveJSON / app.saveStr /
// app.downloadFile / app.FileReader / app.document), so it is fully testable.

import { h, zoomScale, fixedAnchor, attachBackdropClose } from './dom.js';
import { Icon } from './icons.js';
import { flashToast } from './toast.js';
import { renderSavedHistory } from './saved-history.js';
import { buildExportDoc, parseImportDoc, buildMarkdownDoc, buildSqlDoc } from '../core/saved-io.js';
import { newLibrary, replaceLibrary, appendLibrary, renameLibrary, markLibrarySaved } from '../state.js';

/** Library name → safe file base (strips path/illegal chars, collapses spaces). */
const fileBase = (name) => (name || 'queries').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'queries';
const queries = (n) => n + (n === 1 ? ' query' : ' queries');

/** Build the header File button + editable library title; returns the nodes to
 *  splice into the app header (after the connection chip). */
export function libraryControls(app) {
  app.dom.fileBtn = h('button', {
    class: 'hd-file-btn', title: 'File — save or load your library',
    onclick: () => openFileMenu(app),
  }, h('span', null, 'File'), Icon.chevDown());
  app.dom.libraryTitle = h('div', { class: 'lib-title' });
  renderLibraryTitle(app);
  return [app.dom.fileBtn, app.dom.libraryTitle];
}

/** (Re)render the library title into its slot: a click-to-rename name button
 *  with an unsaved-changes dot, or an inline rename input while editing. */
export function renderLibraryTitle(app) {
  const slot = app.dom.libraryTitle;
  if (!slot) return;
  const state = app.state;
  slot.replaceChildren();
  if (app.editingLibrary) {
    const input = h('input', { class: 'lib-name-input', value: state.libraryName.value });
    let done = false;
    // Enter/blur commit; Escape cancels. The guard stops the blur fired by the
    // re-render teardown from undoing a cancel (same pattern as saved rename).
    const finish = (commit) => {
      if (done) return;
      done = true;
      // Leave edit mode first, so the renameLibrary write below repaints the
      // button view via the title effect rather than a transient input.
      app.editingLibrary = false;
      if (commit && input.value.trim()) renameLibrary(state, input.value, app.saveStr);
      renderLibraryTitle(app); // explicit: the cancel/no-op path changes no signal
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    slot.appendChild(input);
    setTimeout(() => { input.focus(); input.select(); });
    return;
  }
  slot.appendChild(h('button', {
    class: 'lib-name', title: 'Rename library',
    onclick: () => { app.editingLibrary = true; renderLibraryTitle(app); },
  }, h('span', { class: 'lib-name-text' }, state.libraryName.value),
     state.libraryDirty.value ? h('span', { class: 'lib-dirty', title: 'Unsaved changes since last save / load' }) : null));
}

/** Open the File dropdown anchored under the File button (Esc / outside-click close). */
export function openFileMenu(app) {
  if (app.dom.fileMenu) return;
  const doc = app.document;
  const list = app.state.savedQueries;
  const close = () => {
    doc.removeEventListener('keydown', onKey, true);
    if (app.dom.fileMenu) { app.dom.fileMenu.remove(); app.dom.fileMenu = null; }
    if (app.dom.fileMenuOverlay) { app.dom.fileMenuOverlay.remove(); app.dom.fileMenuOverlay = null; }
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };

  const replaceInput = pickerInput(app, (f) => onReplaceFile(app, f));
  const appendInput = pickerInput(app, (f) => onAppendFile(app, f));
  const item = (icon, label, meta, onClick) => h('button', { class: 'fm-item', onclick: onClick },
    h('span', { class: 'fm-icon' }, icon), h('span', { class: 'fm-label' }, label),
    meta ? h('span', { class: 'fm-meta' }, meta) : null);
  const sep = () => h('div', { class: 'fm-sep' });
  const empty = list.length === 0;

  const newLibraryItem = item(Icon.plus(), 'New Library', null, () => { close(); newLibraryAction(app); });
  const menu = h('div', { class: 'file-menu' },
    newLibraryItem,
    sep(),
    h('div', { class: 'fm-section' }, 'Save library'),
    item(Icon.download(), 'Save JSON', '.json', () => { close(); saveJsonAction(app); }),
    sep(),
    h('div', { class: 'fm-section' }, 'Load from file'),
    item(Icon.upload(), 'Open…', null, () => { replaceInput.click(); close(); }),
    item(Icon.upload(), 'Append…', null, () => { appendInput.click(); close(); }),
    sep(),
    h('div', { class: 'fm-section' }, 'Share / publish'),
    item(Icon.download(), 'Download Markdown', '.md', () => { close(); downloadAction(app, 'md'); }),
    item(Icon.download(), 'Download SQL', '.sql', () => { close(); downloadAction(app, 'sql'); }),
    h('div', { class: 'fm-count' }, empty ? 'Library is empty' : queries(list.length) + ' in Library'),
    replaceInput, appendInput);

  const overlay = h('div', { class: 'fm-overlay', onclick: close });
  app.dom.fileMenuOverlay = overlay;
  app.dom.fileMenu = menu;
  doc.body.appendChild(overlay);
  const r = app.dom.fileBtn.getBoundingClientRect();
  // Anchor under the button, bridging html{zoom} (see fixedAnchor / zoomScale).
  const a = fixedAnchor(r, zoomScale(app.dom.fileBtn));
  menu.style.position = 'fixed';
  menu.style.top = a.top + 'px';
  menu.style.left = a.left + 'px';
  doc.body.appendChild(menu);
  doc.addEventListener('keydown', onKey, true);
  setTimeout(() => newLibraryItem.focus());
}

// ── file pickers + JSON read ────────────────────────────────────────────────

function pickerInput(app, onPick) {
  return h('input', {
    type: 'file', accept: '.json,application/json', style: { display: 'none' },
    onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onPick(f); },
  });
}

/** Read + parse a JSON library file, then `cb(queries)`. Bad files toast. */
function readJsonFile(app, file, cb) {
  const reader = new (app.FileReader || globalThis.FileReader)();
  reader.onload = () => {
    try { cb(parseImportDoc(String(reader.result)).queries); }
    catch (e) { flashToast('✕ ' + ((e && e.message) || e), { document: app.document }); }
  };
  reader.onerror = () => flashToast('✕ Could not read file', { document: app.document });
  reader.readAsText(file);
}

// ── actions ─────────────────────────────────────────────────────────────────

function saveJsonAction(app) {
  const qs = app.state.savedQueries;
  if (!qs.length) { flashToast('Nothing to save', { document: app.document }); return; }
  app.downloadFile(fileBase(app.state.libraryName.value) + '.json', 'application/json',
    JSON.stringify(buildExportDoc(qs, new Date().toISOString()), null, 2));
  markLibrarySaved(app.state); // clears libraryDirty → title effect drops the dot
  flashToast('Saved ' + queries(qs.length) + ' → .json', { document: app.document });
}

function downloadAction(app, fmt) {
  const qs = app.state.savedQueries;
  if (!qs.length) { flashToast('Nothing to save', { document: app.document }); return; }
  if (fmt === 'md') app.downloadFile(fileBase(app.state.libraryName.value) + '.md', 'text/markdown', buildMarkdownDoc(qs));
  else app.downloadFile(fileBase(app.state.libraryName.value) + '.sql', 'application/sql', buildSqlDoc(qs));
  flashToast('Saved ' + queries(qs.length) + ' → .' + fmt, { document: app.document });
}

function onReplaceFile(app, file) {
  readJsonFile(app, file, (qs) => {
    if (!qs.length) { flashToast('✕ No queries in file', { document: app.document }); return; }
    if (app.state.savedQueries.length) confirmReplace(app, file.name, qs);
    else doReplace(app, qs, file.name);
  });
}

function doReplace(app, qs, fileName) {
  replaceLibrary(app.state, qs, fileName, app.saveJSON, app.saveStr);
  afterLibraryChange(app);
  flashToast('Opened library · ' + queries(qs.length), { document: app.document });
}

function onAppendFile(app, file) {
  readJsonFile(app, file, (qs) => {
    if (!qs.length) { flashToast('✕ No queries in file', { document: app.document }); return; }
    const { added, updated, skipped } = appendLibrary(app.state, qs, app.saveJSON);
    afterLibraryChange(app);
    flashToast('Added ' + added + ' · updated ' + updated + ' · skipped ' + skipped, { document: app.document });
  });
}

function newLibraryAction(app) {
  if (app.state.savedQueries.length) { confirmNew(app); return; }
  doNew(app);
}

function doNew(app) {
  newLibrary(app.state, app.saveJSON, app.saveStr);
  afterLibraryChange(app);
  flashToast('Started a new library', { document: app.document });
}

/** Re-sync the surfaces a library change touches: Save button (tab links may be
 *  pruned) and the saved list (count + rows). The title (name + dirty dot)
 *  repaints itself via the libraryName/libraryDirty effect in createApp. */
function afterLibraryChange(app) {
  app.updateSaveBtn();
  renderSavedHistory(app);
}

// ── confirm dialogs (reuse the modal-backdrop/card visual language) ──────────

function confirmReplace(app, fileName, qs) {
  const cur = app.state.savedQueries.length;
  openConfirm(app, {
    title: 'Open and replace current library?',
    body: [h('span', { class: 'fm-mono' }, fileName), ' contains ', h('b', null, String(qs.length)), ' ',
      qs.length === 1 ? 'query' : 'queries', '. Opening it will replace your current ',
      h('b', null, String(cur)), ' saved ', cur === 1 ? 'query' : 'queries',
      '. Open editor tabs are unaffected. Use Append instead to keep both.'],
    confirmLabel: 'Open',
    onConfirm: () => doReplace(app, qs, fileName),
  });
}

function confirmNew(app) {
  const cur = app.state.savedQueries.length;
  openConfirm(app, {
    title: 'Start a new library?',
    body: ['This clears your current ', h('b', null, String(cur)), ' saved ', cur === 1 ? 'query' : 'queries',
      ' and starts an empty library. Open editor tabs are unaffected. Save first if you want to keep them.'],
    confirmLabel: 'New Library',
    onConfirm: () => doNew(app),
  });
}

function openConfirm(app, { title, body, confirmLabel, onConfirm }) {
  const doc = app.document;
  const close = () => {
    doc.removeEventListener('keydown', onKey, true);
    detachBackdrop();
    if (app.dom.fileDialog) { app.dom.fileDialog.remove(); app.dom.fileDialog = null; }
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const card = h('div', { class: 'fm-dialog-card' },
    h('div', { class: 'fm-dialog-title' }, title),
    h('div', { class: 'fm-dialog-body' }, body),
    h('div', { class: 'fm-dialog-actions' },
      h('button', { class: 'fm-dialog-cancel', onclick: close }, 'Cancel'),
      h('button', { class: 'fm-dialog-confirm', onclick: () => { close(); onConfirm(); } }, confirmLabel)));
  const backdrop = h('div', { class: 'fm-dialog-backdrop' }, card);
  const detachBackdrop = attachBackdropClose(backdrop, close);
  app.dom.fileDialog = backdrop;
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
}
