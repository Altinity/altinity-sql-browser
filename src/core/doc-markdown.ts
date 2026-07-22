// #315 Phase 3 — Markdown -> bounded pure AST for `system.documentation`
// entries. Pure, DOM-free (no globals other than `TextEncoder`/`TextDecoder`,
// same precedent as `doc-documentation.ts`/`core/pkce.ts`); the AST -> DOM
// view lives in `src/ui/doc-markdown-view.ts`.
//
// IMPLEMENTATION (owner decision amending #315's original "no general
// Markdown runtime dependency" non-goal): this module tokenizes with
// `marked@18`'s LEXER ONLY (`import { lexer } from 'marked'` — a pure
// string -> token-tree function). It NEVER calls `marked.parse`/`marked()`
// (the HTML-string renderer) and NEVER touches `innerHTML` anywhere in this
// codebase — marked is used exactly like a hand-rolled tokenizer would be,
// just a more complete/correct one (CommonMark + GFM), and every token is
// mapped by hand into this module's OWN `DocBlock`/`DocInline` union below,
// through the SAME link-policy/byte/node/nesting budgets the hand-written
// parser enforced. A hostile or pathological input that makes
// `marked.lexer` throw (it has an internal infinite-loop guard for
// adversarial input) is still caught by this module's own total-fallback
// `try/catch` — the "never throws" contract does not change.
//
// `DocInline` is RECURSIVE — `strong`/`em`/`del`/`link` carry
// `children: DocInline[]`, mirroring marked's own inline-token tree 1:1
// (`**see [x](y)**` keeps the link as a real `link` node nested inside the
// `strong` node, rather than collapsing to plain text). Nesting is bounded
// by `MAX_DOC_NESTING_DEPTH` exactly like list/quote/admonition nesting —
// past the bound, a container degrades to one literal `text` leaf via
// `flattenTokensToText` instead of recursing further. See `mapInlineTokens`.
//
// Limits (all exported; #315 "Safety and limits"). `MAX_DOC_MARKDOWN_BYTES`
// is the SAME constant `doc-documentation.ts` already declares (its
// `normalizeDocumentationRow` bounds one row's `description` cell to it) —
// imported and re-exported here rather than redeclared, so there is exactly
// one source of truth for that number.
//
// DOCUSAURUS ADMONITIONS (`:::tip ... :::`) are a construct marked has no
// notion of at all — they are pre-scanned OUT of the raw text (tracking
// fenced-code state so a `:::` line inside a ``` block is never mistaken for
// a container) into a `{kind:'admonition', ...}` DocBlock, with the
// surrounding plain-Markdown segments still going through `marked.lexer` as
// normal. See `splitAdmonitions` below.

import { MAX_DOC_MARKDOWN_BYTES } from './doc-documentation.js';
import { lexer as markedLexer } from 'marked';
import type { Token, Tokens } from 'marked';

export { MAX_DOC_MARKDOWN_BYTES };

/** Hard cap on total AST nodes (blocks + inline leaves) a single parse may
 *  emit. Once reached, parsing stops adding further TOP-LEVEL blocks (a
 *  partially-built block already pushed is kept; no more are appended) and
 *  the result's `truncated` flag is set. */
export const MAX_DOC_AST_NODES = 20_000;

/** Hard cap on list/quote/admonition nesting depth. A construct that would
 *  nest deeper than this flattens to a literal-text leaf at the max depth
 *  instead of recursing further. */
export const MAX_DOC_NESTING_DEPTH = 16;

/** Hard cap, in UTF-8 bytes, on one fenced code block's content. A longer
 *  block is truncated to this bound and flagged `truncated: true` on the
 *  `code` node (independent of the whole-document `truncated` flag). */
export const MAX_DOC_CODE_BLOCK_BYTES = 250_000;

/** Hard cap on the number of links (across the whole document) that may
 *  resolve to a real `link` node. Once reached, further otherwise-valid links
 *  render as plain text — the exact same "policy rejected this href" path a
 *  disallowed scheme takes. */
export const MAX_DOC_LINKS = 1_000;

// ── AST ──────────────────────────────────────────────────────────────────────

// RECURSIVE (owner decision amending this module's earlier flattened shape):
// `strong`/`em`/`del`/`link` carry `children: DocInline[]`, mirroring marked's
// own inline-token tree 1:1, so `**see [x](y)**` keeps the link as a REAL
// `link` node nested inside the `strong` node, rather than collapsing to a
// plain-text leaf. `code` (a codespan) stays a leaf — CommonMark itself never
// nests further formatting inside a code span. Nesting is bounded the same
// way list/quote/admonition nesting is (see `MAX_DOC_NESTING_DEPTH`): past
// the bound, a `strong`/`em`/`del`/`link` degrades to a single literal `text`
// leaf instead of recursing further — see `mapInlineTokens`.
export type DocInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: DocInline[] }
  | { kind: 'link'; href: string; children: DocInline[] };

/** One list item: its own inline content, plus an optional nested sub-list
 *  (bounded by `MAX_DOC_NESTING_DEPTH` — beyond the bound, nested lines
 *  flatten into this item's own `inline` as literal text instead of a
 *  `children` sub-list). */
export interface DocListItem {
  inline: DocInline[];
  children?: DocBlock[];
}

export type DocBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inline: DocInline[] }
  | { kind: 'paragraph'; inline: DocInline[] }
  | { kind: 'code'; language: string | null; text: string; truncated?: boolean }
  | { kind: 'list'; ordered: boolean; start: number; items: DocListItem[] }
  | { kind: 'quote'; blocks: DocBlock[] }
  | { kind: 'break' }
  | { kind: 'table'; header: DocInline[][]; rows: DocInline[][][] }
  | { kind: 'admonition'; variant: string; title: string | null; blocks: DocBlock[] };

export interface DocMarkdownResult {
  blocks: DocBlock[];
  truncated: boolean;
}

// ── Link policy ──────────────────────────────────────────────────────────────

/**
 * Pure allowlisted relative-link mapper (#315: "Relative links may use a pure
 * allowlisted ClickHouse-doc URL mapper"). Accepts only a scheme-less,
 * host-less path with no `..` traversal segment; rejects (`null`) anything
 * else — a bare query/fragment-only string, an absolute URL, a
 * protocol-relative `//host` string, or a path containing `..`. A leading
 * `/` is stripped and internal repeated slashes are collapsed before mapping
 * to `https://clickhouse.com/docs/<cleaned>`.
 */
export function clickhouseDocUrl(path: string): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null; // has a scheme
  if (trimmed.startsWith('//')) return null; // protocol-relative (has a host)
  if (trimmed.includes('..')) return null; // traversal
  const cleaned = trimmed.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!cleaned) return null;
  return 'https://clickhouse.com/docs/' + cleaned;
}

/**
 * Default link policy (#315 "Safety and limits"): an absolute `https:` URL
 * passes through unchanged; a scheme-less relative path routes through
 * `clickhouseDocUrl`; anything else (`http:`, `javascript:`, `data:`,
 * `mailto:`, a protocol-relative `//host`, empty/malformed) is rejected —
 * the caller then renders the construct as literal text.
 */
export function defaultDocLinkPolicy(href: string): string | null {
  if (typeof href !== 'string' || !href) return null;
  if (/^https:\/\//i.test(href)) return href;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null; // any other scheme
  if (href.startsWith('//')) return null; // protocol-relative host
  return clickhouseDocUrl(href);
}

// ── Source path -> public docs URL ──────────────────────────────────────────

// A confidently-derivable `system.documentation` `source` cell: a repo-
// relative path under `docs/` (optionally with an `en/` locale segment, the
// historical ClickHouse/ClickHouse docs-tree layout) ending in `.md`. Any
// other shape (no recognizable prefix, no `.md` suffix, an absolute path, a
// URL) is NOT confidently derivable — `latestDocUrlFromSource` returns `null`
// rather than guess, and the pane omits the "View latest" link entirely.
const SOURCE_MD_RE = /^docs\/(?:en\/)?(.+)\.md$/;

/**
 * Derive the public `https://clickhouse.com/docs/...` URL for #315's "View
 * latest on clickhouse.com" pane link from `system.documentation`'s OPTIONAL
 * `source` column, or `null` when the mapping isn't confidently derivable
 * (see `SOURCE_MD_RE` above). The cleaned remainder (after stripping the
 * `docs/`/`docs/en/` prefix and `.md` suffix) is run back through
 * `clickhouseDocUrl` — reusing its traversal/scheme rejection and slash
 * cleanup rather than duplicating them, so `docs/en/../../etc/passwd.md`
 * (or any other `..`-bearing source) still comes back `null`. Pure.
 */
export function latestDocUrlFromSource(source: string | null | undefined): string | null {
  if (typeof source !== 'string') return null;
  const m = SOURCE_MD_RE.exec(source.trim());
  if (!m) return null;
  return clickhouseDocUrl(m[1]);
}

// ── Byte bounding ────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

// Truncate `raw` to at most `maxBytes` UTF-8 bytes. A cut mid-multi-byte
// sequence decodes with the replacement character rather than throwing (same
// approach as `doc-documentation.ts`'s private `boundMarkdown`, which this
// module cannot import — it's not exported, and its constant IS, see above).
function truncateBytes(raw: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(raw);
  if (bytes.length <= maxBytes) return { text: raw, truncated: false };
  return { text: decoder.decode(bytes.slice(0, maxBytes)), truncated: true };
}

// Coerce arbitrary input to a string without ever throwing — e.g. a hostile
// object whose own `toString` throws must not defeat `parseDocMarkdown`'s
// "never throws" contract, including in its OWN catch-path fallback (which
// stringifies the original input a second time). Used everywhere this module
// would otherwise write `String(x ?? '')`.
function safeString(v: unknown): string {
  try {
    return v == null ? '' : String(v);
  } catch {
    return '';
  }
}

// ── Parse context (budgets) ─────────────────────────────────────────────────

interface Ctx {
  nodeCount: number;
  truncated: boolean;
  linkPolicy: (href: string) => string | null;
}

function overBudget(ctx: Ctx): boolean {
  return ctx.nodeCount >= MAX_DOC_AST_NODES;
}

function countNode(ctx: Ctx): void {
  ctx.nodeCount += 1;
  if (ctx.nodeCount >= MAX_DOC_AST_NODES) ctx.truncated = true;
}

// ── Inline mapping (marked tokens -> recursive DocInline[]) ─────────────────

// A soft line break WITHIN a run of inline content (a paragraph/heading/
// quote/table-cell/etc. spanning multiple SOURCE lines with no blank line
// between them) is not a hard line break in rendered Markdown — CommonMark
// collapses it to a single space (this is exactly what a browser's default
// `white-space: normal` text flow would do with the literal token text a
// renderer emits; `docs-md-p`/`docs-md-h`/etc. use `white-space: pre-wrap`
// instead, so this module normalizes the newline itself, matching the old
// hand-written parser's `lines.join(' ')` paragraph behavior). Applies to
// `text`/`escape`/`codespan` token content — CommonMark's "line endings are
// treated like spaces" rule for code spans too. Block-level fenced code
// (`code` tokens) is UNAFFECTED — that content is preserved byte-exact,
// mapped straight through `mapBlocks`'s own `case 'code'`, never through here.
function normalizeSoftBreaks(s: string): string {
  return s.replace(/\n/g, ' ');
}

// Render a (possibly nested) marked inline-token subtree down to plain text —
// used ONLY as the MAX_DOC_NESTING_DEPTH escape hatch: a `strong`/`em`/`del`/
// `link` construct nested past the bound degrades to one literal `text` leaf
// (see `mapInlineTokens`) rather than recursing further, so its own further
// nested formatting is still rendered (as plain text), never dropped.
function flattenTokensToText(tokens: Token[]): string {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'escape':
      case 'codespan':
        out += normalizeSoftBreaks(t.text);
        break;
      case 'br':
        out += ' ';
        break;
      case 'html':
      case 'image':
        out += t.raw;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        out += flattenTokensToText(t.tokens ?? []);
        break;
      // No `default`: this exhausts every inline-level `MarkedToken` kind
      // marked's own type union declares (`checkbox` is the only inline
      // kind NOT listed here — it only ever appears as a list item's own
      // top-level token, alongside its `text`/`paragraph` content, never
      // nested inside an inline run; see `mapListItem`/`mapBlocks`, which
      // DO have a `default` for exactly that "beyond this subset" case).
      // A `Tokens.Generic` token from a marked *extension* is likewise
      // impossible here — this module never calls `marked.use(...)`.
    }
  }
  return out;
}

// Map one marked inline-token list into the RECURSIVE `DocInline` tree —
// `strong`/`em`/`del`/`link` carry real nested children (marked's own inline
// tree, 1:1), so e.g. a link inside bold text stays a real `link` node inside
// a real `strong` node. `inlineDepth` is this tree's OWN nesting counter
// (independent of `mapBlocks`'s block-nesting `depth` — a heading's inline
// formatting can nest regardless of how deep the heading's own block sits);
// past `MAX_DOC_NESTING_DEPTH` a container degrades to one literal `text`
// leaf via `flattenTokensToText` instead of recursing further. Every node
// (leaf or container) counts once against `ctx`'s shared `MAX_DOC_AST_NODES`
// budget via `countNode` — once exhausted, this function simply stops
// appending further nodes (a container already pushed keeps whatever
// children it was given up to that point).
function mapInlineTokens(tokens: Token[], ctx: Ctx, inlineDepth: number): DocInline[] {
  const out: DocInline[] = [];
  for (const t of tokens) {
    if (overBudget(ctx)) break;
    switch (t.type) {
      case 'text':
      case 'escape':
        out.push({ kind: 'text', text: normalizeSoftBreaks(t.text) });
        countNode(ctx);
        break;
      case 'codespan':
        out.push({ kind: 'code', text: normalizeSoftBreaks(t.text) });
        countNode(ctx);
        break;
      case 'br':
        out.push({ kind: 'text', text: ' ' });
        countNode(ctx);
        break;
      case 'strong':
      case 'em':
      case 'del': {
        const emphTokens = (t as Tokens.Strong | Tokens.Em | Tokens.Del).tokens;
        if (inlineDepth + 1 >= MAX_DOC_NESTING_DEPTH) {
          out.push({ kind: 'text', text: flattenTokensToText(emphTokens) });
        } else {
          out.push({ kind: t.type, children: mapInlineTokens(emphTokens, ctx, inlineDepth + 1) });
        }
        countNode(ctx);
        break;
      }
      case 'link': {
        const linkTokens = (t as Tokens.Link).tokens;
        const mapped = ctx.linkPolicy(t.href);
        if (mapped === null) {
          // Policy-rejected (unsafe scheme, over the link budget, …) —
          // render the ORIGINAL source markdown construct as literal text,
          // exactly like a disallowed-scheme link always has, WHEREVER this
          // link sits (top-level or nested inside `strong`/`em`/`del`).
          out.push({ kind: 'text', text: t.raw });
        } else if (inlineDepth + 1 >= MAX_DOC_NESTING_DEPTH) {
          out.push({ kind: 'link', href: mapped, children: [{ kind: 'text', text: flattenTokensToText(linkTokens) }] });
        } else {
          out.push({ kind: 'link', href: mapped, children: mapInlineTokens(linkTokens, ctx, inlineDepth + 1) });
        }
        countNode(ctx);
        break;
      }
      case 'image':
        // Images never render (#315 spec) — always literal source text,
        // regardless of link policy.
        out.push({ kind: 'text', text: t.raw });
        countNode(ctx);
        break;
      case 'html':
        out.push({ kind: 'text', text: t.raw });
        countNode(ctx);
        break;
      // No `default`: see `flattenTokensToText`'s comment above — every
      // inline-level `MarkedToken` kind is enumerated; `checkbox` and any
      // extension `Generic` token cannot occur here.
    }
  }
  return out;
}

function mapInline(tokens: Token[] | undefined, ctx: Ctx): DocInline[] {
  return mapInlineTokens(tokens ?? [], ctx, 0);
}

// A heading's trailing Docusaurus explicit-anchor suffix (`Foo {#foo}`) is
// stripped from the LAST inline leaf if (and only if) it is a plain `text`
// node ending in that pattern — mirrors `doc-capability.ts`'s
// `firstProseLine` convention (same regex substance), applied post-flatten
// rather than on the raw heading source line, since marked already tokenized
// it into `DocInline[]` by the time this module sees it.
const HEADING_ANCHOR_RE = /\s*\{#[^}]*\}\s*$/;

function stripHeadingAnchor(inline: DocInline[]): DocInline[] {
  if (inline.length === 0) return inline;
  const last = inline[inline.length - 1];
  if (last.kind !== 'text') return inline;
  const stripped = last.text.replace(HEADING_ANCHOR_RE, '');
  if (stripped === last.text) return inline;
  if (stripped === '') return inline.slice(0, -1);
  return [...inline.slice(0, -1), { kind: 'text', text: stripped }];
}

// ── List mapping ─────────────────────────────────────────────────────────────

function mapListItem(item: Tokens.ListItem, ctx: Ctx, depth: number): DocListItem {
  if (depth + 1 >= MAX_DOC_NESTING_DEPTH) {
    return { inline: [{ kind: 'text', text: item.text }] };
  }
  const inline: DocInline[] = [];
  const children: DocBlock[] = [];
  let ownConsumed = false;
  for (const sub of item.tokens) {
    // A tight-list item's own content is one `text` token; a LOOSE-list
    // item's own content is one `paragraph` token instead. Either way, only
    // the FIRST such token becomes this item's flat `inline` — any further
    // own-content token (a second paragraph in a multi-paragraph loose item)
    // becomes a nested `paragraph` DocBlock instead of being dropped.
    if (!ownConsumed && (sub.type === 'text' || sub.type === 'paragraph')) {
      inline.push(...mapInline((sub as Tokens.Text | Tokens.Paragraph).tokens, ctx));
      ownConsumed = true;
      continue;
    }
    children.push(...mapBlocks([sub], ctx, depth + 1));
  }
  const result: DocListItem = { inline };
  if (children.length) result.children = children;
  return result;
}

// Each list item counts once against `ctx`'s shared `MAX_DOC_AST_NODES`
// budget for its OWN container (mirroring every other `mapBlocks` case,
// which counts the container it just pushed) — `mapListItem`'s own nested
// `mapInline`/`mapBlocks` calls separately count that item's CONTENT. A
// plain `.map` over `t.items` would keep manufacturing `DocListItem`
// entries even once the budget is exhausted (`mapInline` inside them just
// starts returning `[]`), so a 250k-item list would still yield 250k
// (empty) list items -> 250k DOM nodes in `doc-markdown-view.ts`. Instead:
// stop enumerating items entirely once over budget. `countNode` already
// flips `ctx.truncated` the moment the counter hits the cap, so no item is
// EVER silently dropped without `truncated` being set — the `break` only
// ever runs after the item that tripped `truncated` (or on an already-set
// budget from earlier sibling content).
function mapList(t: Tokens.List, ctx: Ctx, depth: number): DocBlock & { kind: 'list' } {
  const ordered = t.ordered;
  const start = ordered && typeof t.start === 'number' ? t.start : 1;
  const items: DocListItem[] = [];
  for (const item of t.items) {
    if (overBudget(ctx)) break;
    countNode(ctx);
    items.push(mapListItem(item, ctx, depth));
  }
  return { kind: 'list', ordered, start, items };
}

// ── Table mapping ────────────────────────────────────────────────────────────

// Same reasoning as `mapList` above, applied to header cells, rows, and the
// cells within each row: a plain `.map` over `t.header`/`t.rows`/`row` would
// keep manufacturing header cells / row containers / cell containers forever
// once the budget is exhausted (their `mapInline` content just goes empty),
// so a 250k-row table would still yield 250k empty rows -> 250k `<tr>`s in
// `doc-markdown-view.ts`. Instead stop enumerating as soon as the shared
// budget is spent, at each of the three levels independently — a table can
// run out of budget mid-row (some cells present, rest dropped) or between
// rows (whole row dropped), and either way `countNode` has already set
// `ctx.truncated` before the corresponding `break` fires.
function mapTable(t: Tokens.Table, ctx: Ctx): DocBlock & { kind: 'table' } {
  const header: DocInline[][] = [];
  for (const cell of t.header) {
    if (overBudget(ctx)) break;
    countNode(ctx);
    header.push(mapInline(cell.tokens, ctx));
  }
  const rows: DocInline[][][] = [];
  for (const row of t.rows) {
    if (overBudget(ctx)) break;
    countNode(ctx);
    const mappedRow: DocInline[][] = [];
    for (const cell of row) {
      if (overBudget(ctx)) break;
      countNode(ctx);
      mappedRow.push(mapInline(cell.tokens, ctx));
    }
    rows.push(mappedRow);
  }
  return { kind: 'table', header, rows };
}

// ── Block mapping (marked tokens -> DocBlock[]) ─────────────────────────────

function clampHeadingLevel(depth: number): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(1, depth)) as 1 | 2 | 3 | 4 | 5 | 6;
}

function mapBlocks(tokens: Token[], ctx: Ctx, depth: number): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const t of tokens) {
    if (overBudget(ctx)) break;
    switch (t.type) {
      case 'space':
      case 'def':
        // 'space' is inter-block whitespace; 'def' is a reference-link
        // definition — both invisible, neither becomes a DocBlock.
        break;
      case 'hr':
        blocks.push({ kind: 'break' });
        countNode(ctx);
        break;
      case 'heading': {
        const inline = stripHeadingAnchor(mapInline(t.tokens, ctx));
        blocks.push({ kind: 'heading', level: clampHeadingLevel(t.depth), inline });
        countNode(ctx);
        break;
      }
      case 'paragraph':
      case 'text': {
        const inline = mapInline((t as Tokens.Paragraph | Tokens.Text).tokens, ctx);
        blocks.push({ kind: 'paragraph', inline });
        countNode(ctx);
        break;
      }
      case 'code': {
        const langWord = (t.lang || '').trim().split(/\s+/)[0];
        const lang = langWord ? langWord : null;
        const { text, truncated } = truncateBytes(t.text, MAX_DOC_CODE_BLOCK_BYTES);
        blocks.push(
          truncated
            ? { kind: 'code', language: lang, text, truncated: true }
            : { kind: 'code', language: lang, text },
        );
        countNode(ctx);
        break;
      }
      case 'blockquote': {
        const bq = t as Tokens.Blockquote;
        if (depth + 1 >= MAX_DOC_NESTING_DEPTH) {
          blocks.push({ kind: 'paragraph', inline: [{ kind: 'text', text: normalizeSoftBreaks(bq.text) }] });
        } else {
          blocks.push({ kind: 'quote', blocks: mapBlocks(bq.tokens, ctx, depth + 1) });
        }
        countNode(ctx);
        break;
      }
      case 'list':
        blocks.push(mapList(t as Tokens.List, ctx, depth));
        countNode(ctx);
        break;
      case 'table':
        blocks.push(mapTable(t as Tokens.Table, ctx));
        countNode(ctx);
        break;
      case 'html':
        blocks.push({ kind: 'paragraph', inline: [{ kind: 'text', text: t.raw }] });
        countNode(ctx);
        break;
      default:
        // Any other/future marked block token beyond this module's subset
        // (e.g. a footnote extension) -> literal raw text, never dropped.
        blocks.push({ kind: 'paragraph', inline: [{ kind: 'text', text: (t as { raw?: string }).raw ?? '' }] });
        countNode(ctx);
    }
  }
  return blocks;
}

// ── Docusaurus admonitions (`:::kind [title]` ... `:::`) ────────────────────

// Kinds Docusaurus itself recognizes. Anything else keeps the (pre-existing)
// literal behavior — an unrecognized `:::foo` line is not a container start,
// so it falls straight through to `marked.lexer` like any other paragraph
// text (Markdown has no other meaning for `:::`, so it renders as literal
// text there too).
const ADMONITION_VARIANTS = new Set(['tip', 'note', 'info', 'warning', 'danger', 'important']);
const ADMONITION_OPEN_RE = /^:::(\S+)(?:[ \t]+(.*?))?[ \t]*$/;
const ADMONITION_CLOSE_RE = /^:::[ \t]*$/;
// A fenced code block's OWN `:::`-lookalike content must never be mistaken
// for an admonition boundary — and the pre-scan MUST agree with marked
// about where fences end, or an admonition boundary read inside what
// marked considers one code block tears content apart (review finding).
// CommonMark rule (what marked implements): a closing fence uses the SAME
// character as the opener with a run length >= the opener's, and carries
// nothing but whitespace after the run; a shorter/other-char run is
// ordinary code content. Track char+length, not a boolean toggle.
interface FenceOpen { char: string; len: number }
const FENCE_RUN_RE = /^(`{3,}|~{3,})(.*)$/;

// null → not a fence line; otherwise the run (with `rest` for close checks).
function fenceRun(trimmed: string): { char: string; len: number; rest: string } | null {
  const m = FENCE_RUN_RE.exec(trimmed);
  return m ? { char: m[1][0], len: m[1].length, rest: m[2] } : null;
}

// Threads one open-fence state through a line: returns the new state.
function nextFenceState(state: FenceOpen | null, line: string): FenceOpen | null {
  const run = fenceRun(line.trim());
  if (!run) return state;
  if (state === null) return { char: run.char, len: run.len }; // opener (info string allowed)
  // Only a same-char, >=-length, bare run closes the open fence.
  if (run.char === state.char && run.len >= state.len && run.rest.trim() === '') return null;
  return state; // shorter/other-char/suffixed run is code CONTENT
}

type MixedSegment =
  | { kind: 'md'; text: string }
  | { kind: 'literal'; text: string }
  | { kind: 'admonition'; variant: string; title: string | null; inner: string };

function splitAdmonitions(text: string): MixedSegment[] {
  const lines = text.split('\n');
  const segments: MixedSegment[] = [];
  let plain: string[] = [];
  let fence: FenceOpen | null = null;
  let i = 0;

  const flushPlain = (): void => {
    if (plain.length) {
      segments.push({ kind: 'md', text: plain.join('\n') });
      plain = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (fence === null) {
      const openM = ADMONITION_OPEN_RE.exec(line);
      const variant = openM ? openM[1].toLowerCase() : null;
      if (openM && variant && ADMONITION_VARIANTS.has(variant)) {
        // Find the MATCHING close, bracket-style: any `:::word` line found
        // while scanning (recognized variant or not — Docusaurus containers
        // all share this one delimiter syntax) opens a nested level that
        // must be closed by its OWN bare `:::` before a bare `:::` can close
        // THIS container. Without this counter, a deeply nested chain of
        // admonitions (as MAX_DOC_NESTING_DEPTH's own test constructs) would
        // pair the outermost opener with the INNERMOST closer instead.
        let j = i + 1;
        let closeIdx = -1;
        let nestedFence: FenceOpen | null = null;
        let nestedAdmonitions = 0;
        while (j < lines.length) {
          // A fence-run line is never an admonition marker itself (it starts
          // with ` or ~), so thread the fence state and move on; markers only
          // count while no fence is open.
          if (fenceRun(lines[j].trim())) {
            nestedFence = nextFenceState(nestedFence, lines[j]);
          } else if (nestedFence === null) {
            if (ADMONITION_OPEN_RE.test(lines[j])) {
              nestedAdmonitions++;
            } else if (ADMONITION_CLOSE_RE.test(lines[j])) {
              if (nestedAdmonitions === 0) {
                closeIdx = j;
                break;
              }
              nestedAdmonitions--;
            }
          }
          j++;
        }
        if (closeIdx !== -1) {
          flushPlain();
          const rawTitle = openM[2];
          segments.push({
            kind: 'admonition',
            variant,
            title: rawTitle && rawTitle.trim() ? rawTitle.trim() : null,
            inner: lines.slice(i + 1, closeIdx).join('\n'),
          });
          i = closeIdx + 1;
          continue;
        }
        // Unterminated opener: never swallow the content — everything from
        // the opener line to EOF renders as one literal-text block instead
        // of being fed to marked (which has no notion of `:::` at all and
        // would just paragraph-ify it in some ad-hoc way).
        flushPlain();
        segments.push({ kind: 'literal', text: lines.slice(i).join('\n') });
        i = lines.length;
        continue;
      }
    }
    fence = nextFenceState(fence, line);
    plain.push(line);
    i++;
  }
  flushPlain();
  return segments;
}

function parseMixedBlocks(text: string, depth: number, ctx: Ctx): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const seg of splitAdmonitions(text)) {
    if (overBudget(ctx)) break;
    if (seg.kind === 'md') {
      blocks.push(...mapBlocks(markedLexer(seg.text), ctx, depth));
    } else if (seg.kind === 'literal') {
      blocks.push({ kind: 'paragraph', inline: [{ kind: 'text', text: seg.text }] });
      countNode(ctx);
    } else if (depth + 1 >= MAX_DOC_NESTING_DEPTH) {
      // Nesting budget reached: flatten the whole container back to its
      // literal source form rather than recursing further.
      const header = `:::${seg.variant}${seg.title ? ' ' + seg.title : ''}`;
      blocks.push({ kind: 'paragraph', inline: [{ kind: 'text', text: `${header}\n${seg.inner}\n:::` }] });
      countNode(ctx);
    } else {
      const inner = parseMixedBlocks(seg.inner, depth + 1, ctx);
      blocks.push({ kind: 'admonition', variant: seg.variant, title: seg.title, blocks: inner });
      countNode(ctx);
    }
  }
  return blocks;
}

// ── Entry point ──────────────────────────────────────────────────────────────

function parseDocMarkdownInner(
  markdown: string,
  opts: { linkPolicy?: (href: string) => string | null } | undefined,
): DocMarkdownResult {
  const rawInput = safeString(markdown);
  const { text: bounded, truncated: byteTruncated } = truncateBytes(rawInput, MAX_DOC_MARKDOWN_BYTES);

  const basePolicy = opts?.linkPolicy ?? defaultDocLinkPolicy;
  let linkCount = 0;
  const linkPolicy = (href: string): string | null => {
    if (linkCount >= MAX_DOC_LINKS) return null;
    const resolved = basePolicy(href);
    if (resolved !== null) linkCount++;
    return resolved;
  };

  const ctx: Ctx = { nodeCount: 0, truncated: byteTruncated, linkPolicy };
  const blocks = parseMixedBlocks(bounded, 0, ctx);
  return { blocks, truncated: ctx.truncated };
}

/**
 * Parse `markdown` into the bounded pure AST above. NEVER throws: any
 * internal error (including a hostile injected `linkPolicy` that itself
 * throws, or `marked.lexer` hitting its own internal infinite-loop guard on
 * adversarial input) is caught and reported as a fallback single plain-text
 * paragraph block containing the raw, untruncated input — the caller-visible
 * contract is total. `opts.linkPolicy` overrides `defaultDocLinkPolicy`;
 * either way it is wrapped to also enforce `MAX_DOC_LINKS`.
 */
export function parseDocMarkdown(
  markdown: string,
  opts?: { linkPolicy?: (href: string) => string | null },
): DocMarkdownResult {
  try {
    return parseDocMarkdownInner(markdown, opts);
  } catch {
    return {
      blocks: [{ kind: 'paragraph', inline: [{ kind: 'text', text: safeString(markdown) }] }],
      truncated: false,
    };
  }
}
