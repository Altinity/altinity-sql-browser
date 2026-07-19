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

// #314 Phase 2 — human labels for the four structured kinds, alongside
// Phase 1's function/aggregate-function.
const KIND_LABELS: Partial<Record<DocKind, string>> = {
  'aggregate-function': 'aggregate function',
  format: 'format',
  'table-engine': 'table engine',
  'database-engine': 'database engine',
  'data-type': 'data type',
};
const kindLabel = (kind: DocKind): string => KIND_LABELS[kind] || 'function';
const targetKey = (t: DocTarget): string => t.kind + ':' + t.name;

// #314 — the session-local "related"/alias navigation back stack is bounded
// so an unbounded browsing session can't grow it forever; a new push past the
// cap silently drops the OLDEST entry (the visitor can still walk back
// through the most recent 20 hops).
const BACK_STACK_CAP = 20;

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
  /** #314 — the session-local back stack: each entry is the target that was
   *  ON SCREEN right before a related/alias navigation replaced it. Torn down
   *  wholesale with the rest of `PaneState` on `closeDocPane` — which is also
   *  app.ts's `signOut` connection-change hook — so it never needs a separate
   *  reset path (see that call site's comment). A fresh EXTERNAL `openDocEntry`
   *  call (hover/F1/completion — never an internal related/alias/back
   *  navigation) starts a new browsing session and clears it. */
  backStack: DocTarget[];
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
    keyHandler: () => {}, backStack: [],
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

// #314 — a Back button, shown whenever the session-local back stack is
// non-empty, in every rendered state (loading/missing/unavailable/found —
// navigating away can land on any of them, and the visitor still wants a way
// back). Pops the stack and re-runs the lookup for the popped target with a
// FRESH visited-set (a step back is not part of the just-abandoned alias
// chain, so the cycle guard starts over — matches a brand-new `openDocEntry`).
function backButtonRow(app: DocPaneApp, doc: Document, st: PaneState): HTMLElement | null {
  if (!st.backStack.length) return null;
  return h('div', { class: 'docs-back-row' },
    h('button', {
      class: 'docs-back', type: 'button', 'aria-label': 'Back',
      onclick: () => {
        const target = st.backStack.pop()!;
        runLookup(app, doc, st, target, new Set());
      },
    }, Icon.chevLeft(), h('span', null, 'Back')));
}

function renderLoading(app: DocPaneApp, doc: Document, st: PaneState): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-loading' },
    backButtonRow(app, doc, st),
    h('span', { class: 'spin' }, Icon.spinner()), h('span', null, 'Loading…')));
}

function renderMissing(app: DocPaneApp, doc: Document, st: PaneState, target: DocTarget): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-missing' },
    backButtonRow(app, doc, st),
    h('p', null, 'No documentation for ' + target.name + '.')));
}

function renderUnavailable(app: DocPaneApp, doc: Document, st: PaneState, onRetry: () => void): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-unavailable' },
    backButtonRow(app, doc, st),
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
  const backRow = backButtonRow(app, doc, st);

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

  // #314 — the full multi-line syntax block (`system.table_engines`/
  // `system.database_engines`/`system.data_type_families`'s `syntax` column;
  // NEVER set for `format` — see doc-types.ts's `syntaxFull` comment). Reuses
  // the same injected CodeViewer seam as the examples block above (never a
  // second, ad hoc `<pre>` styling) — it's read-only reference text, not an
  // editable example, but the CM6 viewer renders either the same way.
  let syntaxBlock: HTMLElement | null = null;
  if (entry.syntaxFull) {
    const syntaxText = entry.syntaxFull;
    const syntaxHost = h('div', { class: 'docs-syntax-code' });
    st.viewers.push(app.CodeViewer({
      parent: syntaxHost, document: doc, text: syntaxText, language: 'sql', wrap: true,
      languageExtension: chLanguageExtension(app.catalog.refData),
    }));
    syntaxBlock = h('div', { class: 'docs-field docs-syntax' },
      h('div', { class: 'docs-field-label' }, 'Syntax'),
      syntaxHost);
  }

  // #314 — capability facts (`system.formats`' capability-flag columns +
  // `content_type`, `system.table_engines`' capability-flag columns) as
  // label:value chips. Only ever populated with columns the normalizer
  // actually confirmed present AND non-null on the row (doc-capability.ts's
  // `boolFacts`/`buildFacts`) — never fabricated.
  const factsBlock = entry.facts && entry.facts.length
    ? h('div', { class: 'docs-field docs-facts' },
      h('div', { class: 'docs-field-label' }, 'Facts'),
      h('div', { class: 'docs-facts-list' },
        ...entry.facts.map((f) => h('span', { class: 'docs-chip docs-fact' }, f.label + ': ' + f.value))))
    : null;

  // #314 — related entries: an item with a resolvable `target` is a
  // keyboard-reachable button that navigates the SAME pane in place (through
  // the identical `navigate` callback the alias link above uses — one
  // unified related/alias navigation path, back-stack included); a
  // label-only item (no resolvable target) is an inert text chip.
  const relatedBlock = entry.related && entry.related.length
    ? h('div', { class: 'docs-field docs-related' },
      h('div', { class: 'docs-field-label' }, 'Related'),
      h('div', { class: 'docs-related-list' },
        ...entry.related.map((r) => (r.target
          ? h('button', {
            class: 'docs-related-link', type: 'button',
            onclick: () => navigate(r.target!, nextVisited),
          }, r.label)
          : h('span', { class: 'docs-chip docs-related-chip' }, r.label)))))
    : null;

  st.body.replaceChildren(h('div', { class: 'docs-entry' },
    backRow,
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
    syntaxBlock,
    factsBlock,
    relatedBlock,
    examplesBlock));
}

// #314 — push the target that was on screen right before a related/alias
// navigation moves away from it, capped at BACK_STACK_CAP (drops the oldest
// entry rather than growing unbounded).
function pushBack(st: PaneState, from: DocTarget): void {
  st.backStack.push(from);
  if (st.backStack.length > BACK_STACK_CAP) st.backStack.shift();
}

function runLookup(app: DocPaneApp, doc: Document, st: PaneState, target: DocTarget, visited: Set<string>): void {
  st.token++;
  const myToken = st.token;
  renderLoading(app, doc, st);
  app.catalog.docEntry(target).then((lookup: DocLookup<DocEntry>) => {
    // Stale-response guard: the pane may have been closed (its token was
    // bumped by closeDocPane, or the panel was detached) or retargeted
    // (a newer lookup already bumped `st.token`) while this was in flight —
    // discard silently rather than paint over whatever's now on screen.
    if (myToken !== st.token || !st.panel.isConnected) return;
    if (lookup.status === 'found') {
      // #314 — the SAME navigate callback backs BOTH the alias link
      // (renderFound's `aliasNotice`) and every "related" action button
      // (renderFound's `related` block) — one unified in-place navigation
      // path that also records the back-stack entry.
      renderFound(app, doc, st, lookup.value, visited, (nextTarget, nextVisited) => {
        pushBack(st, lookup.value.target);
        runLookup(app, doc, st, nextTarget, nextVisited);
      });
    } else if (lookup.status === 'missing') {
      renderMissing(app, doc, st, target);
    } else {
      renderUnavailable(app, doc, st, () => runLookup(app, doc, st, target, visited));
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
  // #314 — every EXTERNAL open (hover button, completion info, F1, a fresh
  // schema-surface action) starts a new browsing session: any back-stack
  // built by a PRIOR session's related/alias hops no longer describes a path
  // back to anything the visitor just did, so it's cleared here — the only
  // paths that ever push onto it are the in-place `navigate` calls inside
  // `runLookup`'s 'found' branch (alias link + related actions), never this
  // entry point.
  st.backStack = [];
  runLookup(app, doc, st, target, new Set());
}
