// #315 Phase 3 — the bounded pure AST (`core/doc-markdown.ts`'s `DocBlock`/
// `DocInline`) -> safe DOM view. Companion to `src/ui/panels.ts`'s
// `renderMarkdown` (the `core/markdown-lite.js` Grafana-text-panel view) —
// same "build DOM by construction, never innerHTML" discipline, but over
// `doc-markdown.ts`'s richer, FLATTENED block/inline union (headings up to
// h6, lists with nested sub-lists, quotes, thematic breaks, tables, fenced
// code) rather than panels.js's 3-block subset.
//
// Pure render function over its inputs: no `app`/global access. The ONE
// side-effecting capability it needs — mounting a read-only CM6 viewer for a
// SQL-tagged fenced code block — is threaded in through `opts.codeViewer`, the
// same injected-seam discipline `doc-pane.ts` already applies to its own
// examples/syntax blocks (never a concrete CM6 import here). `opts.registerViewer`
// is the other half of that seam: this module has no lifecycle of its own
// (no "current render" to tear down), so every `CodeViewerHandle` it creates
// is handed back to the caller (doc-pane.ts, which already owns a per-pane
// `viewers` teardown list for its examples/syntax blocks) via this callback,
// once per viewer, in creation order — the caller destroys them exactly like
// any other viewer it mounted itself.
//
// `opts.onNavigateRelative` is declared but typed `never` — #315 explicitly
// scopes internal doc-link navigation OUT of this commit (only `related`/
// `aliasTo` navigation, unaffected by this module, exists today). The field
// exists so a later commit's signature change is additive (no existing call
// site needs to change shape), not so it can be passed.

import { h, withDocument } from './dom.js';
import type { CodeViewerFactory, CodeViewerHandle } from '../editor/code-viewer.types.js';
import type { Extension } from '@codemirror/state';
import type { DocBlock, DocInline, DocListItem, DocMarkdownResult } from '../core/doc-markdown.js';

/** The injected CodeViewer seam a SQL-tagged fenced code block mounts through
 *  — mirrors `doc-pane.ts`'s own `app.CodeViewer` + `chLanguageExtension(...)`
 *  pairing for its examples/syntax blocks. Omitted entirely (rather than
 *  passing a no-op factory) is how a caller says "no CM6 available here" —
 *  every code block, SQL-tagged or not, then falls back to a plain
 *  `<pre><code>`. */
export interface DocMarkdownCodeViewer {
  factory: CodeViewerFactory;
  languageExtension: Extension | Extension[];
}

export interface DocMarkdownViewOptions {
  codeViewer?: DocMarkdownCodeViewer;
  /** Reserved for a later commit (#315 explicitly scopes internal doc-link
   *  navigation out of this one) — never actually passable today. */
  onNavigateRelative?: never;
  /** Receives every `CodeViewerHandle` this render call creates, once each,
   *  in creation order — the caller's own teardown list (e.g. `doc-pane.ts`'s
   *  per-pane `viewers` array) is where these get destroyed; this module
   *  keeps none of its own. */
  registerViewer?: (viewer: CodeViewerHandle) => void;
}

// ── Inline ───────────────────────────────────────────────────────────────────

// Renders the RECURSIVE `DocInline` tree. Links only ever arrive here already
// policy-approved (`parseDocMarkdown`'s `linkPolicy` turned a rejected href
// into a plain `{kind:'text'}` leaf before this module ever sees it) — so
// every `link` node is rendered as a real, safe `<a>` unconditionally.
// `strong`/`em`/`del`/`link` recurse into their own `children` — a link
// nested inside bold text renders a real `<a>` inside the `<strong>`, a
// codespan inside a link renders a real `<code>` inside the `<a>`, etc.
function renderInline(nodes: DocInline[]): (Node | string)[] {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'text': return n.text;
      case 'code': return h('code', null, n.text);
      case 'strong': return h('strong', null, ...renderInline(n.children));
      case 'em': return h('em', null, ...renderInline(n.children));
      case 'del': return h('del', null, ...renderInline(n.children));
      case 'link':
        return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, ...renderInline(n.children));
    }
  });
}

// ── Heading level -> tag ─────────────────────────────────────────────────────

// The pane's own entry title is an `<h3>` (`doc-pane.ts`'s `.docs-name`,
// OUTSIDE this module's returned container) — so a Markdown body's own
// top-level `#` heading (AST level 1) must never ALSO render as `<h3>`, or
// the pane would carry two same-level "top" headings. Offsetting every level
// by +3 (level 1 -> h4, level 2 -> h5, level 3..6 -> h6) keeps the entry
// title the only h3 while still preserving Markdown's own relative nesting
// order up to the h6 floor, after which everything flattens to h6.
function headingTag(level: 1 | 2 | 3 | 4 | 5 | 6): string {
  return 'h' + Math.min(6, level + 3);
}

// ── Code block ───────────────────────────────────────────────────────────────

function renderCodeBlock(
  doc: Document, block: DocBlock & { kind: 'code' }, opts: DocMarkdownViewOptions,
): HTMLElement {
  // SQL code blocks use the shared ClickHouse CM6 language (#315) — ONLY
  // when the fence is explicitly tagged `sql`; every other language (or no
  // language at all) renders as plain preformatted text, never highlighted.
  const isSql = (block.language || '').trim().toLowerCase() === 'sql';
  const host = h('div', { class: 'docs-md-code' });
  if (isSql && opts.codeViewer) {
    const cmHost = h('div', { class: 'docs-md-code-cm' });
    const viewer = opts.codeViewer.factory({
      parent: cmHost, document: doc, text: block.text, language: 'sql', wrap: true,
      languageExtension: opts.codeViewer.languageExtension,
    });
    opts.registerViewer?.(viewer);
    host.appendChild(cmHost);
  } else {
    host.appendChild(h('pre', { class: 'docs-md-code-plain' }, h('code', null, block.text)));
  }
  // No per-block Copy button (owner decision at the #320 gate — the buttons
  // read as noise under every fence); code text selects/copies normally.
  if (block.truncated) host.appendChild(h('div', { class: 'docs-md-note' }, '(truncated)'));
  return host;
}

// ── List ─────────────────────────────────────────────────────────────────────

function renderListItem(doc: Document, item: DocListItem, opts: DocMarkdownViewOptions): HTMLLIElement {
  const li = h('li', { class: 'docs-md-li' }, ...renderInline(item.inline));
  if (item.children) {
    for (const child of item.children) li.appendChild(renderBlock(doc, child, opts));
  }
  return li;
}

// ── Admonition ───────────────────────────────────────────────────────────────

function renderAdmonition(
  doc: Document, block: DocBlock & { kind: 'admonition' }, opts: DocMarkdownViewOptions,
): HTMLElement {
  const children: (Node | string)[] = [];
  if (block.title) children.push(h('div', { class: 'docs-md-admonition-title' }, block.title));
  for (const b of block.blocks) children.push(renderBlock(doc, b, opts));
  return h('aside', { class: `docs-md-admonition docs-md-admonition-${block.variant}` }, ...children);
}

// ── Table ────────────────────────────────────────────────────────────────────

function renderTable(doc: Document, block: DocBlock & { kind: 'table' }, opts: DocMarkdownViewOptions): HTMLElement {
  const thead = h('thead', null,
    h('tr', null, ...block.header.map((cell) => h('th', null, ...renderInline(cell)))));
  const tbody = h('tbody', null,
    ...block.rows.map((row) => h('tr', null, ...row.map((cell) => h('td', null, ...renderInline(cell))))));
  return h('table', { class: 'docs-md-table' }, thead, tbody);
}

// ── Block dispatch ───────────────────────────────────────────────────────────

function renderBlock(doc: Document, block: DocBlock, opts: DocMarkdownViewOptions): HTMLElement {
  switch (block.kind) {
    case 'heading':
      return h(headingTag(block.level) as 'h6', { class: 'docs-md-h' }, ...renderInline(block.inline));
    case 'paragraph':
      return h('p', { class: 'docs-md-p' }, ...renderInline(block.inline));
    case 'code':
      return renderCodeBlock(doc, block, opts);
    case 'list': {
      const attrs: Record<string, unknown> = { class: 'docs-md-list' };
      if (block.ordered && block.start !== 1) attrs.start = block.start;
      return h(block.ordered ? 'ol' : 'ul', attrs, ...block.items.map((item) => renderListItem(doc, item, opts)));
    }
    case 'quote':
      return h('blockquote', { class: 'docs-md-quote' }, ...block.blocks.map((b) => renderBlock(doc, b, opts)));
    case 'break':
      return h('hr', { class: 'docs-md-hr' });
    case 'table':
      return renderTable(doc, block, opts);
    case 'admonition':
      return renderAdmonition(doc, block, opts);
  }
}

/**
 * Render a `parseDocMarkdown` result (`core/doc-markdown.ts`) into a DOM
 * subtree — every block/inline construct built by direct element/text-node
 * construction (never `innerHTML`), so an injected malicious payload can only
 * ever have been already turned into a `{kind:'text'}` leaf upstream, never
 * live markup here. `doc` selects which document's realm elements are built
 * in (mirrors `drawer.ts`/`results.ts`'s own `withDocument(doc, …)` pattern) —
 * this module never reads the ambient global `document`.
 */
export function renderDocMarkdown(
  doc: Document, result: DocMarkdownResult, opts: DocMarkdownViewOptions = {},
): HTMLElement {
  return withDocument(doc, () => {
    const container = h('div', { class: 'docs-md' });
    for (const block of result.blocks) container.appendChild(renderBlock(doc, block, opts));
    if (result.truncated) {
      container.appendChild(h('div', { class: 'docs-md-note docs-md-truncated' }, 'Content truncated.'));
    }
    return container;
  });
}
