// #315 Phase 3 — Markdown -> bounded pure AST for `system.documentation`
// entries. Pure, DOM-free (no globals other than `TextEncoder`/`TextDecoder`,
// same precedent as `doc-documentation.ts`/`core/pkce.ts`); the AST -> DOM
// view is a LATER commit (`src/ui/doc-markdown-view.ts`).
//
// DESIGN CONSTRAINT (agreed at plan review): this is NOT a second independent
// inline parser. Bold/italic/inline-code/links come from `markdown-lite.ts`'s
// `parseInline` (the SAME regex `panels.js`'s Grafana-text-panel profile
// uses), lifted behind an options bag (`ParseInlineOptions.linkPolicy`) so
// this module can inject its own stricter policy without forking the regex.
// `markdown-lite.ts` remains the panels.js profile (http-or-https, no
// fences/tables/quotes/breaks) — its exports/behavior are unchanged and its
// existing tests pass unmodified; the only shared-regex change is a `(?<!!)`
// image guard (see markdown-lite.ts's comment), which is additive since
// nothing previously exercised `![alt](url)`.
//
// markdown-lite's inline nodes are RECURSIVE (`strong`/`em`/`link` carry
// `children: MdInlineNode[]`, so `**a *b***` nests). This module's `DocInline`
// is intentionally FLATTENED (`strong`/`em`/`code` carry a plain `text`
// string, no nesting) per #315's agreed API — the DOM view only ever needs to
// emit one leaf node per inline span, and flattening here (once, in the pure
// layer) means the DOM view never has to recurse. `flattenInline` below does
// this by rendering nested children down to their plain text.
//
// Limits (all exported; #315 "Safety and limits"). `MAX_DOC_MARKDOWN_BYTES`
// is the SAME constant `doc-documentation.ts` already declares (its
// `normalizeDocumentationRow` bounds one row's `description` cell to it) —
// imported and re-exported here rather than redeclared, so there is exactly
// one source of truth for that number. The actual truncation LOGIC differs
// (that module bounds a single already-fetched cell; this one bounds the raw
// input to a whole-document parse) so a small local `truncateBytes` helper
// covers this module's own byte-bounding needs.

import { MAX_DOC_MARKDOWN_BYTES } from './doc-documentation.js';
import { parseInline as parseMdInline } from './markdown-lite.js';
import type { MdInlineNode } from './markdown-lite.js';

export { MAX_DOC_MARKDOWN_BYTES };

/** Hard cap on total AST nodes (blocks + inline leaves) a single parse may
 *  emit. Once reached, parsing stops adding further TOP-LEVEL blocks (a
 *  partially-built block already pushed is kept; no more are appended) and
 *  the result's `truncated` flag is set. */
export const MAX_DOC_AST_NODES = 20_000;

/** Hard cap on list/quote nesting depth. A construct that would nest deeper
 *  than this flattens to a literal-text leaf at the max depth instead of
 *  recursing further. */
export const MAX_DOC_NESTING_DEPTH = 16;

/** Hard cap, in UTF-8 bytes, on one fenced code block's content. A longer
 *  block is truncated to this bound and flagged `truncated: true` on the
 *  `code` node (independent of the whole-document `truncated` flag). */
export const MAX_DOC_CODE_BLOCK_BYTES = 250_000;

/** Hard cap on the number of links (across the whole document) that may
 *  resolve to a real `link` node. Once reached, further otherwise-valid links
 *  render as plain text — the exact same "policy rejected this href" path a
 *  disallowed scheme takes (see `markdown-lite.ts`'s `parseInline`). */
export const MAX_DOC_LINKS = 1_000;

// ── AST ──────────────────────────────────────────────────────────────────────

export type DocInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'em' | 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

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
  | { kind: 'table'; header: DocInline[][]; rows: DocInline[][][] };

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

// ── Inline bridging (markdown-lite reuse) ───────────────────────────────────

// Render a (possibly nested) markdown-lite inline node list down to plain
// text — used to flatten `strong`/`em`/`link` children into `DocInline`'s
// flat `text` field.
function inlineToPlainText(nodes: MdInlineNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') out += n.text;
    else out += inlineToPlainText(n.children);
  }
  return out;
}

function flattenInline(nodes: MdInlineNode[]): DocInline[] {
  return nodes.map((n): DocInline => {
    switch (n.t) {
      case 'text':
        return { kind: 'text', text: n.text };
      case 'code':
        return { kind: 'code', text: n.text };
      case 'strong':
        return { kind: 'strong', text: inlineToPlainText(n.children) };
      case 'em':
        return { kind: 'em', text: inlineToPlainText(n.children) };
      case 'link':
        return { kind: 'link', text: inlineToPlainText(n.children), href: n.href };
    }
  });
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

function parseInlineBudgeted(text: string, ctx: Ctx): DocInline[] {
  const flat = flattenInline(parseMdInline(text, { linkPolicy: ctx.linkPolicy }));
  ctx.nodeCount += flat.length;
  if (ctx.nodeCount >= MAX_DOC_AST_NODES) ctx.truncated = true;
  return flat;
}

// ── Block-level regexes ──────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_START_RE = /^```(\S*)\s*$/;
const FENCE_END_RE = /^```\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const LIST_ITEM_RE = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/;

interface ListItemMatch {
  indent: number;
  ordered: boolean;
  num: number | null;
  content: string;
}

function matchListItem(line: string): ListItemMatch | null {
  const m = LIST_ITEM_RE.exec(line);
  if (!m) return null;
  return {
    indent: m[1].length,
    ordered: m[2] === undefined,
    num: m[3] !== undefined ? parseInt(m[3], 10) : null,
    content: m[4],
  };
}

// ── Table ────────────────────────────────────────────────────────────────────

const TABLE_SEP_CELL_RE = /^:?-+:?$/;

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function tryParseTable(
  lines: string[],
  idx: number,
  ctx: Ctx,
): { block: DocBlock & { kind: 'table' }; nextIdx: number } | null {
  // Callers only reach here when `lines[idx]` (the header line) is already
  // known to contain '|' — no need to re-check it.
  if (idx + 1 >= lines.length) return null;
  const headerLine = lines[idx];
  const sepLine = lines[idx + 1];
  if (!sepLine.includes('|')) return null;
  const headerCells = splitTableRow(headerLine);
  const sepCells = splitTableRow(sepLine);
  if (sepCells.length !== headerCells.length) return null;
  if (!sepCells.every((c) => TABLE_SEP_CELL_RE.test(c))) return null;

  const header = headerCells.map((c) => parseInlineBudgeted(c, ctx));
  const rows: DocInline[][][] = [];
  let i = idx + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || !line.includes('|')) break;
    rows.push(splitTableRow(line).map((c) => parseInlineBudgeted(c, ctx)));
    i++;
  }
  return { block: { kind: 'table', header, rows }, nextIdx: i };
}

// ── Lists ────────────────────────────────────────────────────────────────────

function parseList(
  lines: string[],
  idx: number,
  baseIndent: number,
  depth: number,
  ctx: Ctx,
): { block: DocBlock & { kind: 'list' }; nextIdx: number } {
  const first = matchListItem(lines[idx]) as ListItemMatch;
  const ordered = first.ordered;
  const start = ordered && first.num !== null ? first.num : 1;
  const items: DocListItem[] = [];
  let i = idx;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    const m = matchListItem(line);
    if (!m) break;
    if (m.indent < baseIndent) break;

    if (m.indent > baseIndent) {
      // Reachable only once at least one same-indent item has been pushed:
      // `parseList` is always entered with `baseIndent` equal to its very
      // first line's own indent (see the call sites below), so the first
      // iteration of any invocation never lands here.
      const last = items[items.length - 1];
      if (depth + 1 >= MAX_DOC_NESTING_DEPTH) {
        // Bounded nesting: flatten deeper content into the parent item's own
        // inline content as literal text instead of recursing further.
        last.inline.push({ kind: 'text', text: line.trim() });
        i++;
        continue;
      }
      const sub = parseList(lines, i, m.indent, depth + 1, ctx);
      countNode(ctx);
      last.children = last.children ? [...last.children, sub.block] : [sub.block];
      i = sub.nextIdx;
      continue;
    }

    // Same indent: a marker-family switch (ul <-> ol) starts a NEW list —
    // stop here without consuming the line (mirrors markdown-lite's rule).
    if (m.ordered !== ordered) break;
    items.push({ inline: parseInlineBudgeted(m.content, ctx) });
    i++;
  }

  return { block: { kind: 'list', ordered, start, items }, nextIdx: i };
}

// ── Block-level parse ────────────────────────────────────────────────────────

function parseBlocks(lines: string[], depth: number, ctx: Ctx): DocBlock[] {
  const blocks: DocBlock[] = [];
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length && !overBudget(ctx)) {
      blocks.push({ kind: 'paragraph', inline: parseInlineBudgeted(para.join(' '), ctx) });
      countNode(ctx);
    }
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (overBudget(ctx)) break;
    const line = lines[i];

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    const fenceM = FENCE_START_RE.exec(line);
    if (fenceM) {
      flushPara();
      const lang = fenceM[1] || null;
      i++;
      const codeLines: string[] = [];
      // Unterminated fence: content runs to EOF and is still emitted as a
      // code block (documented, tested choice — a dropped closing fence is
      // far more common in real Markdown than a paragraph that just happens
      // to start with three backticks).
      while (i < lines.length && !FENCE_END_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence line
      const { text: codeText, truncated: codeTrunc } = truncateBytes(codeLines.join('\n'), MAX_DOC_CODE_BLOCK_BYTES);
      if (!overBudget(ctx)) {
        const block: DocBlock = codeTrunc
          ? { kind: 'code', language: lang, text: codeText, truncated: true }
          : { kind: 'code', language: lang, text: codeText };
        blocks.push(block);
        countNode(ctx);
      }
      continue;
    }

    if (THEMATIC_BREAK_RE.test(line)) {
      flushPara();
      if (!overBudget(ctx)) {
        blocks.push({ kind: 'break' });
        countNode(ctx);
      }
      i++;
      continue;
    }

    const hm = HEADING_RE.exec(line);
    if (hm) {
      flushPara();
      if (!overBudget(ctx)) {
        const level = Math.min(6, hm[1].length) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({ kind: 'heading', level, inline: parseInlineBudgeted(hm[2], ctx) });
        countNode(ctx);
      }
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushPara();
      const quoteLines: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quoteLines.push(lines[i].replace(QUOTE_RE, '$1'));
        i++;
      }
      if (!overBudget(ctx)) {
        if (depth + 1 >= MAX_DOC_NESTING_DEPTH) {
          blocks.push({ kind: 'paragraph', inline: [{ kind: 'text', text: quoteLines.join(' ') }] });
        } else {
          blocks.push({ kind: 'quote', blocks: parseBlocks(quoteLines, depth + 1, ctx) });
        }
        countNode(ctx);
      }
      continue;
    }

    if (line.includes('|')) {
      const tableResult = tryParseTable(lines, i, ctx);
      if (tableResult) {
        flushPara();
        if (!overBudget(ctx)) {
          blocks.push(tableResult.block);
          countNode(ctx);
        }
        i = tableResult.nextIdx;
        continue;
      }
      // Malformed table (no valid separator row, or column-count mismatch):
      // falls through to plain-paragraph handling below.
    }

    const topListM = matchListItem(line);
    if (topListM) {
      // No depth guard needed here: a list starting at the CURRENT ambient
      // depth is never itself "too deep" — only its own nested sub-lists can
      // be, and `parseList` bounds those internally against the same
      // `MAX_DOC_NESTING_DEPTH` (the quote-nesting guard above already keeps
      // `depth` from ever reaching the limit before `parseBlocks` is called).
      flushPara();
      const { block, nextIdx } = parseList(lines, i, topListM.indent, depth, ctx);
      if (!overBudget(ctx)) {
        blocks.push(block);
        countNode(ctx);
      }
      i = nextIdx;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
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
  const lines = bounded.split(/\r?\n/);
  const blocks = parseBlocks(lines, 0, ctx);
  return { blocks, truncated: ctx.truncated };
}

/**
 * Parse `markdown` into the bounded pure AST above. NEVER throws: any
 * internal error (including a hostile injected `linkPolicy` that itself
 * throws) is caught and reported as a fallback single plain-text paragraph
 * block containing the raw, untruncated input — the caller-visible contract
 * is total. `opts.linkPolicy` overrides `defaultDocLinkPolicy`; either way it
 * is wrapped to also enforce `MAX_DOC_LINKS`.
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
