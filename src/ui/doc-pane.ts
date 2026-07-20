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
import { chLanguageExtension } from '../editor/ch-lang.js';
import type { CodeViewerFactory, CodeViewerHandle } from '../editor/code-viewer.types.js';
import type { AssembledReference } from '../core/completions.js';
import type { DocTarget, DocLookup, DocEntry, DocKind, DocSummary } from '../core/doc-types.js';
import { parseDocMarkdown, defaultDocLinkPolicy, latestDocUrlFromSource } from '../core/doc-markdown.js';
import { renderDocMarkdown } from './doc-markdown-view.js';
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
    /** #315 — name-only disambiguation across every kind sharing a name;
     *  backs `openDocDisambiguation` below (F1 on a bare word the classifier
     *  couldn't resolve a strong target for). */
    docDisambiguate(name: string): Promise<DocLookup<DocSummary[]>>;
    refData: AssembledReference;
  };
  CodeViewer: CodeViewerFactory;
}

// #314 Phase 2 — human labels for the four structured kinds, alongside
// Phase 1's function/aggregate-function. #315 Phase 3 adds every broad
// `system.documentation` kind (`doc-types.ts`'s `DocKind`) EXCEPT `'unknown'`
// — an unknown kind always displays its entry's own `serverTypeLabel`
// instead (see `markdownKindLabel` below), never a value from this map.
const KIND_LABELS: Partial<Record<DocKind, string>> = {
  'aggregate-function': 'aggregate function',
  format: 'format',
  'table-engine': 'table engine',
  'database-engine': 'database engine',
  'data-type': 'data type',
  'table-function': 'table function',
  'dictionary-layout': 'dictionary layout',
  'dictionary-source': 'dictionary source',
  'aggregate-combinator': 'aggregate combinator',
  'skipping-index': 'data-skipping index',
  'disk-type': 'disk type',
  setting: 'setting',
  'mergetree-setting': 'MergeTree setting',
  'server-setting': 'server setting',
  codec: 'codec',
  metric: 'metric',
  'system-table': 'system table',
};
const kindLabel = (kind: DocKind): string => KIND_LABELS[kind] || 'function';

// #315 — the kind badge text for a `renderMode: 'markdown-subset'` entry:
// `'unknown'` (a server `type` label this build doesn't recognize yet) shows
// the entry's own preserved `serverTypeLabel` verbatim rather than the
// generic `kindLabel` fallback ('function'), which would be actively
// misleading for e.g. a codec or metric entry.
const markdownKindLabel = (entry: DocEntry): string =>
  entry.target.kind === 'unknown' ? (entry.serverTypeLabel || 'unknown') : kindLabel(entry.target.kind);
const targetKey = (t: DocTarget): string => t.kind + ':' + t.name;

// #314 — the session-local "related"/alias navigation back stack is bounded
// so an unbounded browsing session can't grow it forever; a new push past the
// cap silently drops the OLDEST entry (the visitor can still walk back
// through the most recent 20 hops).
const BACK_STACK_CAP = 20;

/** #315 — one back-stack entry: either a real doc target that was on screen
 *  (the #314 shape — popping it re-runs `docEntry`), or the name of a
 *  disambiguation LIST that was on screen before a candidate was selected off
 *  it (popping it re-runs `docDisambiguate` and re-renders the list, rather
 *  than jumping straight to a target) — this is what lets Back return to the
 *  list instead of skipping over it. */
type BackEntry = { kind: 'target'; target: DocTarget } | { kind: 'disambiguation'; name: string };

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
  /** #314/#315 — the session-local back stack: each entry describes what was
   *  ON SCREEN right before a related/alias/disambiguation navigation
   *  replaced it (see `BackEntry`). Torn down wholesale with the rest of
   *  `PaneState` on `closeDocPane` — which is also app.ts's `signOut`
   *  connection-change hook — so it never needs a separate reset path (see
   *  that call site's comment). A fresh EXTERNAL `openDocEntry`/
   *  `openDocDisambiguation` call (hover/F1/completion — never an internal
   *  related/alias/back navigation) starts a new browsing session and clears
   *  it. */
  backStack: BackEntry[];
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
/** True when a documentation pane is currently open in `app.document` —
 *  the global Escape shortcut (ui/shortcuts.ts) closes the pane FIRST,
 *  before its cancel-running-query action, so Esc works from anywhere
 *  (not only with focus inside the pane). */
export function isDocPaneOpen(app: DocPaneApp): boolean {
  return panes.has(app.document);
}

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
        const entry = st.backStack.pop()!;
        // #315 — a popped 'disambiguation' entry re-runs docDisambiguate and
        // re-renders the LIST state (Back returns to the list a candidate was
        // chosen from); a 'target' entry (the #314 shape) re-runs docEntry
        // for that target, exactly as before.
        if (entry.kind === 'disambiguation') runDisambiguate(app, doc, st, entry.name);
        else runLookup(app, doc, st, entry.target, new Set());
      },
    }, Icon.chevLeft(), h('span', null, 'Back')));
}

function renderLoading(app: DocPaneApp, doc: Document, st: PaneState): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-loading' },
    backButtonRow(app, doc, st),
    h('span', { class: 'spin' }, Icon.spinner()), h('span', null, 'Loading…')));
}

function renderMissing(app: DocPaneApp, doc: Document, st: PaneState, name: string): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-missing' },
    backButtonRow(app, doc, st),
    h('p', null, 'No documentation for ' + name + '.')));
}

function renderUnavailable(app: DocPaneApp, doc: Document, st: PaneState, onRetry: () => void): void {
  destroyViewers(st);
  st.body.replaceChildren(h('div', { class: 'docs-state docs-unavailable' },
    backButtonRow(app, doc, st),
    h('p', null, "Reference data isn't available on this server or connection."),
    h('button', { class: 'docs-retry', onclick: onRetry }, Icon.refresh(), h('span', null, 'Retry'))));
}


const badge = (text: string, cls: string): HTMLElement => h('span', { class: 'docs-badge ' + cls }, text);

// A long-text, Markdown-bearing structured field (description/arguments/
// parameters/returnedValue — #313/#314 `system.functions`/structured-source
// cells frequently carry Docusaurus-flavored Markdown: admonitions, links,
// tables, SQL fences, per a live-verified real 26.6.1 server). Rendered
// through the SAME bounded pure parser + safe-DOM view #315's broad
// `system.documentation` path already uses (`parseDocMarkdown` ->
// `renderDocMarkdown`), with the SAME CodeViewer/registerViewer wiring
// `renderMarkdownEntry` below threads through — so a ```sql fence inside a
// function's Arguments text gets the identical highlighting a broad-source
// entry's body does (no per-block Copy buttons — owner decision at the #320
// gate), and any mounted CM6 viewer joins the pane's per-render teardown
// list. Keeps the field-label
// structure (`.docs-field`/`.docs-field-label`) — only the value changes
// from a plain text div to the rendered Markdown container.
function markdownField(
  app: DocPaneApp, doc: Document, st: PaneState, label: string, text: string | undefined,
): HTMLElement | null {
  if (!text) return null;
  const parsed = parseDocMarkdown(text, { linkPolicy: defaultDocLinkPolicy });
  const body = renderDocMarkdown(doc, parsed, {
    codeViewer: { factory: app.CodeViewer, languageExtension: chLanguageExtension(app.catalog.refData) },
    registerViewer: (v) => st.viewers.push(v),
  });
  return h('div', { class: 'docs-field' },
    h('div', { class: 'docs-field-label' }, label),
    body);
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

  // `examples` on real servers is a MARKDOWN document — `**bold**` section
  // titles between ```sql / ```response fences — not one SQL snippet (#60
  // live finding). Render it like the other long-text fields: each fence
  // becomes its own code block with an exact-text Copy button (sql fences
  // get the ClickHouse CM6 highlighting, other languages a plain pre).
  const examplesBlock = markdownField(app, doc, st, 'Examples', entry.examples);
  if (examplesBlock) examplesBlock.classList.add('docs-examples');

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
    markdownField(app, doc, st, entry.description ? 'Description' : 'Summary', entry.description || entry.summary),
    markdownField(app, doc, st, 'Arguments', entry.arguments),
    markdownField(app, doc, st, 'Parameters', entry.parameters),
    markdownField(app, doc, st, 'Returned value', entry.returnedValue),
    h('div', { class: 'docs-flags' }, boolBadge('Deterministic', entry.deterministic), boolBadge('Higher-order', entry.higherOrder)),
    syntaxBlock,
    factsBlock,
    relatedBlock,
    examplesBlock));
}

// #315 Phase 3 — the `renderMode: 'markdown-subset'` counterpart to
// `renderFound` above (structured entries): a compact head (title, kind/
// server-type badge, source path) followed by the safely-rendered Markdown
// body (`parseDocMarkdown` -> `renderDocMarkdown`) and an optional, visually
// secondary "View latest on clickhouse.com" link. Reuses the SAME `viewers`
// teardown list, back-stack row, and stale-response/token machinery as the
// structured path — `runLookup` is the only caller, and it's already guarded
// there.
function renderMarkdownEntry(app: DocPaneApp, doc: Document, st: PaneState, entry: DocEntry): void {
  destroyViewers(st);
  const backRow = backButtonRow(app, doc, st);

  const sourceLine = entry.source
    ? h('div', { class: 'docs-md-source' }, entry.source)
    : null;

  // #315 "oversized" state: the body was longer than MAX_DOC_MARKDOWN_BYTES
  // and was truncated to that bound before it ever reached this pane — a
  // distinct, quiet note alongside (not instead of) the truncated body.
  const oversizedNote = entry.oversized
    ? h('div', { class: 'docs-md-note docs-md-oversized' }, 'Documentation body truncated (too large).')
    : null;

  const parsed = parseDocMarkdown(entry.markdown || '', { linkPolicy: defaultDocLinkPolicy });
  const body = renderDocMarkdown(doc, parsed, {
    codeViewer: { factory: app.CodeViewer, languageExtension: chLanguageExtension(app.catalog.refData) },
    registerViewer: (v) => st.viewers.push(v),
  });

  // "View latest on clickhouse.com" (#315 "Pane behavior") — ONLY when a URL
  // is confidently derivable from `entry.source`; otherwise omitted entirely
  // rather than guessed. Visually secondary (small/muted, below the body) —
  // never competes with the connected server's own documentation.
  const latestUrl = latestDocUrlFromSource(entry.source);
  const latestLink = latestUrl
    ? h('a', {
      class: 'docs-md-latest', href: latestUrl, target: '_blank', rel: 'noopener noreferrer',
    }, 'View latest on clickhouse.com')
    : null;

  st.body.replaceChildren(h('div', { class: 'docs-entry docs-md-entry' },
    backRow,
    h('div', { class: 'docs-head-row' },
      h('h3', { class: 'docs-name' }, entry.title),
      badge(markdownKindLabel(entry), 'docs-badge-kind')),
    sourceLine,
    oversizedNote,
    body,
    latestLink));
}

// #314/#315 — push whatever was on screen right before a related/alias/
// disambiguation-selection navigation moves away from it, capped at
// BACK_STACK_CAP (drops the oldest entry rather than growing unbounded).
function pushBack(st: PaneState, entry: BackEntry): void {
  st.backStack.push(entry);
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
      if (lookup.value.renderMode === 'markdown-subset') {
        // #315 — the broad `system.documentation` path: no alias/related
        // navigation exists on this entry shape (structured-only fields),
        // so there is no `navigate` callback to thread through here.
        renderMarkdownEntry(app, doc, st, lookup.value);
      } else {
        // #314 — the SAME navigate callback backs BOTH the alias link
        // (renderFound's `aliasNotice`) and every "related" action button
        // (renderFound's `related` block) — one unified in-place navigation
        // path that also records the back-stack entry.
        renderFound(app, doc, st, lookup.value, visited, (nextTarget, nextVisited) => {
          pushBack(st, { kind: 'target', target: lookup.value.target });
          runLookup(app, doc, st, nextTarget, nextVisited);
        });
      }
    } else if (lookup.status === 'missing') {
      renderMissing(app, doc, st, target.name);
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

// ── #315 Phase 3 — disambiguation ───────────────────────────────────────────

// The kind badge text for a bare `DocSummary` candidate (unlike
// `markdownKindLabel`, a `DocSummary` never carries `serverTypeLabel` — only
// a full `DocEntry` does — so an 'unknown' kind here shows the literal word
// "unknown" rather than misreporting `kindLabel`'s generic 'function' fallback).
const summaryKindLabel = (target: DocTarget): string => (target.kind === 'unknown' ? 'unknown' : kindLabel(target.kind));

// The accessible disambiguation-list state: a real, keyboard-reachable
// `<button>` per candidate (kind badge + canonical name/title + one-line
// summary), inside a `role="list"` with an `aria-label` naming what's being
// disambiguated — a native `<ul>`/`<li>`/`<button>` structure needs no extra
// ARIA wiring to be tab-reachable and screen-reader-announced as a labelled
// list of actionable items. Selecting a candidate pushes THIS list (by name)
// onto the back stack before navigating, so Back returns to the list rather
// than skipping over it (see `BackEntry`'s 'disambiguation' variant).
function renderDisambiguation(app: DocPaneApp, doc: Document, st: PaneState, name: string, candidates: DocSummary[]): void {
  destroyViewers(st);
  const backRow = backButtonRow(app, doc, st);
  const select = (candidate: DocSummary): void => {
    pushBack(st, { kind: 'disambiguation', name });
    runLookup(app, doc, st, candidate.target, new Set());
  };
  st.body.replaceChildren(h('div', { class: 'docs-state docs-disambiguate' },
    backRow,
    h('p', { class: 'docs-disambiguate-intro' }, 'Multiple documentation entries are named "' + name + '":'),
    h('ul', { class: 'docs-disambiguate-list', role: 'list', 'aria-label': 'Documentation entries named ' + name },
      ...candidates.map((c) => h('li', { class: 'docs-disambiguate-item' },
        h('button', { class: 'docs-disambiguate-link', type: 'button', onclick: () => select(c) },
          h('span', { class: 'docs-badge docs-badge-kind' }, summaryKindLabel(c.target)),
          h('span', { class: 'docs-disambiguate-name' }, c.title || c.target.name),
          h('span', { class: 'docs-disambiguate-summary' }, c.summary)))))));
}

// #315 — the disambiguation lookup: `docDisambiguate(name)` resolves to
// every kind sharing `name`. Zero matches ('missing') shows the same missing
// state `docEntry` uses; exactly one match skips the list entirely and
// navigates straight to it (the SAME `runLookup` path a resolved target
// takes — "when context cannot distinguish", not "when there happen to be
// 2+ rows", is the actual disambiguation trigger); two or more renders the
// accessible list above. Shares the pane's token/stale-response guard with
// `runLookup`.
function runDisambiguate(app: DocPaneApp, doc: Document, st: PaneState, name: string): void {
  st.token++;
  const myToken = st.token;
  renderLoading(app, doc, st);
  app.catalog.docDisambiguate(name).then((lookup: DocLookup<DocSummary[]>) => {
    if (myToken !== st.token || !st.panel.isConnected) return;
    if (lookup.status === 'found') {
      if (lookup.value.length === 1) {
        runLookup(app, doc, st, lookup.value[0].target, new Set());
      } else {
        renderDisambiguation(app, doc, st, name, lookup.value);
      }
    } else if (lookup.status === 'missing') {
      renderMissing(app, doc, st, name);
    } else {
      renderUnavailable(app, doc, st, () => runDisambiguate(app, doc, st, name));
    }
  });
}

/**
 * #315 — name-only disambiguation entry point: F1 (`codemirror-adapter.ts`'s
 * `openReferenceCommand`) calls this when the classifier resolves NO strong
 * target for a bare word that still looks like a plausible identifier (not a
 * literal, not whitespace/punctuation) — the server may know it under a kind
 * the positional classifier never guesses at (a combinator, a setting with
 * no SETTINGS-clause caret, …). Opens the SAME persistent pane `openDocEntry`
 * does (creating it on first use) and starts a fresh browsing session (the
 * back stack is cleared, exactly like `openDocEntry`).
 */
export function openDocDisambiguation(app: DocPaneApp, name: string): void {
  const doc = app.document;
  const st = ensurePane(app, doc);
  st.initiator = doc.activeElement;
  st.backStack = [];
  runDisambiguate(app, doc, st, name);
}
