// The Workbench-owned, persistent, non-modal right-side documentation pane
// (#313): THE single entry point every future "Open reference" action
// (CM6 hover's compact button, completion info, the F1 command) calls to
// show a function/aggregate-function's full catalog entry.
//
// Geometry/behavior (verbatim from #313's "Documentation pane" section):
//  - persistent, non-modal — no backdrop, no focus trap, the editor stays
//    usable underneath it (unlike results.ts's cell-detail drawer, which
//    composes buildDrawerChrome's SAME non-modal chrome with its own modal
//    backdrop — see drawer.ts's header comment);
//  - ONE pane instance per document — a new target replaces the current
//    content rather than opening a second pane;
//  - bounded horizontal resize, via its OWN persisted width (`docPanePx`,
//    state.ts) — never `cellDrawerPx` (the cell-detail drawer's width);
//  - `role="complementary"` with an accessible name;
//  - a close button, and Escape while focus is inside the pane — guarded so
//    it never ALSO fires shortcuts.ts's global Escape handling (see
//    `ensurePane`'s keyHandler comment);
//  - closing restores focus to whatever triggered the open;
//  - distinct loading / found / missing / unavailable states, the last with
//    a Retry button — the catalog (schema-catalog-service.ts's `docEntry`)
//    collapses a transient lookup failure into the SAME
//    `{status:'unavailable'}` as a durable denied/absent capability, so one
//    rendered state (not two) covers both, and Retry is simply "call
//    `docEntry` again": a durable case re-resolves instantly from the
//    still-`unavailable` cache, a transient one gets a fresh attempt.
//
// Deliberately NOT schema-detail.ts's bottom-docked fullscreen-graph pane
// geometry (#313: "Do not require the schema graph's bottom detail pane to
// share this geometry") — this is a right-side drawer built from
// buildDrawerChrome's non-modal chrome (drawer.ts) with a distinct 'docs'
// class prefix, so results.ts's `.cd-backdrop`-keyed `isTopDrawer` stays
// blind to it (there is no backdrop here at all).

import { h } from './dom.js';
import { Icon } from './icons.js';
import { buildDrawerChrome, attachDrawerResize } from './drawer.js';
import { flashToast } from './toast.js';
import { chLanguageExtension } from '../editor/ch-lang.js';
import type { CodeViewerFactory, CodeViewerHandle } from '../editor/code-viewer.types.js';
import type { AssembledReference } from '../core/completions.js';
import type { DocTarget, DocLookup, DocEntry, DocKind } from '../core/doc-types.js';
import type { PreferenceKey } from '../application/app-preferences.js';

/** The narrow app surface this module reads — not the full ~50-member `App`
 *  contract (app.types.ts). A real `App` satisfies this directly (its
 *  `state`/`prefs`/`catalog`/`CodeViewer` fields are strict supersets). */
export interface DocPaneApp {
  document: Document;
  state: { docPanePx: number };
  prefs: { save(name: PreferenceKey, value: unknown): void };
  catalog: {
    docEntry(target: DocTarget): Promise<DocLookup<DocEntry>>;
    refData: AssembledReference;
  };
  CodeViewer: CodeViewerFactory;
  /** Clipboard seam override for tests (or a caller with its own injected
   *  navigator) — mirrors app.ts's own `env.navigator` precedence over the
   *  ambient window (see `copySnapshot`/`share`). Falls back to
   *  `(doc.defaultView || window).navigator`. */
  navigator?: { clipboard?: Clipboard };
}

const kindLabel = (kind: DocKind): string => (kind === 'aggregate-function' ? 'aggregate function' : 'function');
const targetKey = (t: DocTarget): string => t.kind + ':' + t.name;

interface PaneState {
  panel: HTMLElement;
  body: HTMLElement;
  cancelResize: () => void;
  /** Bumped on every fresh lookup (open/retarget/retry) and on close — an
   *  in-flight `docEntry` promise whose captured token no longer matches
   *  this is stale and is dropped silently (never painted). */
  token: number;
  initiator: Element | null;
  /** Every CodeViewer instance mounted into the current body content —
   *  destroyed before the next render (retarget/state change) and on close,
   *  so a stale CM6 view is never left listening/painted underneath. */
  viewers: CodeViewerHandle[];
  keyHandler: (e: KeyboardEvent) => void;
}

const panes = new WeakMap<Document, PaneState>();

function destroyViewers(st: PaneState): void {
  for (const v of st.viewers) v.destroy();
  st.viewers = [];
}

/**
 * Close (and fully tear down) the pane in `app.document`, if one is open —
 * a no-op otherwise. Restores focus to whatever most recently triggered
 * `openDocEntry`, when it's still connected and focusable. This is also the
 * connection-change teardown hook: app.ts's `signOut` calls it alongside
 * `catalog.invalidate()` so pane content never survives a reconnect/sign-out.
 */
export function closeDocPane(app: DocPaneApp): void {
  const doc = app.document;
  const st = panes.get(doc);
  if (!st) return;
  panes.delete(doc);
  st.token++; // any lookup already in flight for this pane is now stale
  st.cancelResize();
  destroyViewers(st);
  doc.removeEventListener('keydown', st.keyHandler, true);
  st.panel.remove();
  const initiator = st.initiator as (Element & { focus?: () => void }) | null;
  if (initiator && initiator.isConnected && typeof initiator.focus === 'function') initiator.focus();
}

function ensurePane(app: DocPaneApp, doc: Document): PaneState {
  const existing = panes.get(doc);
  if (existing) return existing;

  const body = h('div', { class: 'docs-body' });
  const close = (): void => closeDocPane(app);
  const { panel } = buildDrawerChrome(doc, {
    classPrefix: 'docs',
    title: [h('span', { class: 'docs-title-text' }, 'Reference')],
    onClose: close,
  });
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', 'Documentation');
  panel.appendChild(body);

  const cancelResize = attachDrawerResize(app, panel, doc, {
    stateKey: 'docPanePx', axis: 'docPane',
  });

  const st: PaneState = {
    panel, body, cancelResize, token: 0, initiator: null, viewers: [],
    keyHandler: () => {},
  };
  // Escape closes the pane ONLY while focus is inside it, and must never
  // ALSO trigger shortcuts.ts's global `handleKeydown` (which cancels a
  // running query on a plain Escape): preventDefault + stopPropagation, in
  // the CAPTURE phase — matching results.ts's openCellDetail — so this
  // fires before main.ts's bubble-phase global listener regardless of
  // attachment order; `handleKeydown`'s own `if (e.defaultPrevented) return
  // null` guard then skips it entirely.
  st.keyHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (!panel.contains(doc.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  doc.addEventListener('keydown', st.keyHandler, true);

  doc.body.appendChild(panel);
  panes.set(doc, st);
  return st;
}

function renderLoading(st: PaneState): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-loading' },
    h('span', { class: 'spin' }, Icon.spinner()), h('span', null, 'Loading…')));
}

function renderMissing(st: PaneState, target: DocTarget): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-missing' },
    h('p', null, 'No documentation for ' + target.name + '.')));
}

function renderUnavailable(st: PaneState, onRetry: () => void): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-unavailable' },
    h('p', null, "Reference data isn't available on this server or connection."),
    h('button', { class: 'docs-retry', onclick: onRetry }, Icon.refresh(), h('span', null, 'Retry'))));
}

function copyExample(app: DocPaneApp, doc: Document, text: string): void {
  const clip = (app.navigator || (doc.defaultView || window).navigator || {}).clipboard;
  if (clip && clip.writeText) {
    clip.writeText(text)
      .then(() => flashToast('Copied to clipboard', { document: doc }))
      .catch(() => flashToast('Copy failed', { document: doc }));
  } else {
    flashToast('Copy not supported', { document: doc });
  }
}

const badge = (text: string, cls: string): HTMLElement => h('span', { class: 'docs-badge ' + cls }, text);

function field(label: string, text: string | undefined): HTMLElement | null {
  if (!text) return null;
  return h('div', { class: 'docs-field' },
    h('div', { class: 'docs-field-label' }, label),
    h('div', { class: 'docs-field-text' }, text));
}

// Only rendered for a real boolean — `null`/`undefined` ("not reported by
// this server's system.functions") is omitted entirely, never shown as false.
function boolBadge(label: string, value: boolean | null | undefined): HTMLElement | null {
  if (value !== true && value !== false) return null;
  return badge(label + ': ' + (value ? 'yes' : 'no'), 'docs-badge-' + (value ? 'on' : 'off'));
}

type Navigate = (target: DocTarget, visited: Set<string>) => void;

function renderFound(
  app: DocPaneApp, doc: Document, st: PaneState, entry: DocEntry, visited: Set<string>, navigate: Navigate,
): void {
  destroyViewers(st);
  const nextVisited = new Set(visited);
  nextVisited.add(targetKey(entry.target));

  let aliasNotice: HTMLElement | null = null;
  if (entry.aliasTo) {
    const canonical: DocTarget = { kind: entry.target.kind, name: entry.aliasTo };
    const cycle = nextVisited.has(targetKey(canonical));
    aliasNotice = h('div', { class: 'docs-alias' },
      'Alias of ',
      cycle
        ? h('b', null, entry.aliasTo)
        : h('button', {
          class: 'docs-alias-link',
          onclick: () => navigate(canonical, nextVisited),
        }, entry.aliasTo));
  }

  const categories = entry.categories && entry.categories.length
    ? h('div', { class: 'docs-categories' }, ...entry.categories.map((c) => h('span', { class: 'docs-chip' }, c)))
    : null;

  let examplesBlock: HTMLElement | null = null;
  if (entry.examples) {
    const exampleText = entry.examples;
    const codeHost = h('div', { class: 'docs-example-code' });
    // ClickHouse-flavored highlighting (ch-lang.ts's chLanguageExtension,
    // #313) — the same keyword/function set the main editor uses — via the
    // injected `app.CodeViewer` seam's `languageExtension` override, so this
    // never imports a concrete CM6 adapter (rule 2).
    st.viewers.push(app.CodeViewer({
      parent: codeHost, document: doc, text: exampleText, language: 'sql', wrap: true,
      languageExtension: chLanguageExtension(app.catalog.refData),
    }));
    examplesBlock = h('div', { class: 'docs-field docs-examples' },
      h('div', { class: 'docs-field-label' }, 'Examples'),
      codeHost,
      h('button', {
        class: 'docs-copy', title: 'Copy example',
        onclick: () => copyExample(app, doc, exampleText),
      }, Icon.copy(), h('span', null, 'Copy')));
  }

  st.body.replaceChildren(h('div', { class: 'docs-entry' },
    h('div', { class: 'docs-head-row' },
      h('h3', { class: 'docs-name' }, entry.title),
      badge(kindLabel(entry.target.kind), 'docs-badge-kind'),
      entry.introducedIn ? badge('since ' + entry.introducedIn, 'docs-badge-since') : null),
    h('div', { class: 'docs-signature' }, entry.signature),
    aliasNotice,
    categories,
    field(entry.description ? 'Description' : 'Summary', entry.description || entry.summary),
    field('Arguments', entry.arguments),
    field('Parameters', entry.parameters),
    field('Returned value', entry.returnedValue),
    h('div', { class: 'docs-flags' }, boolBadge('Deterministic', entry.deterministic), boolBadge('Higher-order', entry.higherOrder)),
    examplesBlock));
}

function runLookup(app: DocPaneApp, doc: Document, st: PaneState, target: DocTarget, visited: Set<string>): void {
  st.token++;
  const myToken = st.token;
  renderLoading(st);
  app.catalog.docEntry(target).then((lookup: DocLookup<DocEntry>) => {
    // Stale-response guard: the pane may have been closed (its token was
    // bumped by closeDocPane, or the panel was detached) or retargeted
    // (a newer lookup already bumped `st.token`) while this was in flight —
    // discard silently rather than paint over whatever's now on screen.
    if (myToken !== st.token || !st.panel.isConnected) return;
    if (lookup.status === 'found') {
      renderFound(app, doc, st, lookup.value, visited, (nextTarget, nextVisited) => {
        runLookup(app, doc, st, nextTarget, nextVisited);
      });
    } else if (lookup.status === 'missing') {
      renderMissing(st, target);
    } else {
      renderUnavailable(st, () => runLookup(app, doc, st, target, visited));
    }
  });
}

/**
 * THE single action every "Open reference" caller (hover button, completion
 * info, F1 — #313) uses. Opens the persistent pane — creating it on first
 * use, or reusing the live instance (one pane; a new target replaces its
 * content) — and resolves `target` through `app.catalog.docEntry`.
 */
export function openDocEntry(app: DocPaneApp, target: DocTarget): void {
  const doc = app.document;
  const st = ensurePane(app, doc);
  st.initiator = doc.activeElement;
  runLookup(app, doc, st, target, new Set());
}
