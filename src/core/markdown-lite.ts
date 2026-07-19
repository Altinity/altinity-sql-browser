// A deliberately small, safe Markdown subset for text panels (#166). Pure
// parser: text → an AST of plain objects; the DOM is built by the UI layer
// (panels.js) from this tree with createElement/textContent — never innerHTML —
// so raw HTML in the source is inert by construction (it parses as literal
// text, and the renderer can only ever emit it as a text node).
//
// Subset (Grafana-text-panel-ish): # headings (1–6), paragraphs, unordered
// (-/*) and ordered (1.) lists, **bold**, *italic* / _italic_, `inline code`,
// and [links](https://…) restricted to http(s) — any other scheme renders as
// plain text. No fences, images, tables, or raw HTML — full Markdown was
// considered and rejected for a niche panel (hard rule 4: no new runtime dep).
//
// Block AST:  {t:'h', level, children} | {t:'p', children}
//           | {t:'ul', items:[children]} | {t:'ol', items:[children]}
// Inline AST: {t:'text', text} | {t:'strong', children} | {t:'em', children}
//           | {t:'code', text} | {t:'link', href, children}
//
// The AST interfaces below are this parser's canonical source — `panels.js`'s
// DOM renderer (unconverted) pins the identical shapes locally under the same
// names until it converts and imports these directly.

export interface MdTextNode { t: 'text'; text: string }
export interface MdStrongNode { t: 'strong'; children: MdInlineNode[] }
export interface MdEmNode { t: 'em'; children: MdInlineNode[] }
export interface MdCodeNode { t: 'code'; text: string }
export interface MdLinkNode { t: 'link'; href: string; children: MdInlineNode[] }
export type MdInlineNode = MdTextNode | MdStrongNode | MdEmNode | MdCodeNode | MdLinkNode;

export interface MdHeadingBlock { t: 'h'; level: number; children: MdInlineNode[] }
export interface MdParagraphBlock { t: 'p'; children: MdInlineNode[] }
export interface MdListBlock { t: 'ul' | 'ol'; items: MdInlineNode[][] }
export type MdBlock = MdHeadingBlock | MdParagraphBlock | MdListBlock;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+\.\s+(.*)$/;
// Non-greedy inline tokens, matched left-to-right; the first alternative that
// matches at the earliest offset wins. Backticks bind tightest (code spans
// suppress emphasis inside), then bold before italic so ** isn't eaten as two
// *. Bold content admits balanced single-star runs (`**a *b***` nests the
// italic) via the `[^*]|\*[^*]+\*` alternation. The link alternative carries a
// negative lookbehind for `!` so an image marker (`![alt](url)`) is never
// mistaken for a link — the `!` plus the bracket/paren span both fall through
// as literal text (#315's doc-markdown parser, which shares this exact regex,
// requires images to stay literal; markdown-lite never had a test asserting
// the opposite, so this is purely additive).
const INLINE_RE = /(`([^`]+)`)|(\*\*((?:[^*]|\*[^*]+\*)+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)|(?<!!)(\[([^\]]+)\]\(([^)\s]+)\))/;

/** Only http(s) URLs may become real links; anything else stays text. This is
 *  the DEFAULT link policy for `parseMarkdown`/`parseInline` (the panels.js
 *  "Grafana text panel" profile, #166). #315's `doc-markdown.ts` reuses
 *  `parseInline` with its own stricter/relative-mapping policy injected —
 *  see `parseInline`'s `opts.linkPolicy`. */
export function safeLinkHref(href: string): string | null {
  return /^https?:\/\//i.test(href) ? href : null;
}

/** Options for `parseInline`. `linkPolicy` decides which `(url)` targets in a
 *  `[text](url)` construct become a real `link` node vs. render as literal
 *  text — defaults to `safeLinkHref` (http/https only) when omitted, which is
 *  markdown-lite's own (panels.js) behavior. Injecting a different policy
 *  (#315's https-only + relative ClickHouse-doc mapping) is how a second
 *  consumer reuses this SAME inline parser/regex instead of forking it. */
export interface ParseInlineOptions {
  linkPolicy?: (href: string) => string | null;
}

/**
 * Parse one span of text's inline formatting (bold/italic/code/links) into
 * inline nodes. Exported (lifted from a private helper) so `doc-markdown.ts`'s
 * block-level parser can reuse this exact tokenizer for its own inline spans
 * (headings, paragraphs, list items, table cells) rather than re-implementing
 * the regex — see the module doc comment. Called internally by
 * `parseMarkdown` with no `opts` (i.e. the original `safeLinkHref` policy),
 * so existing behavior is unchanged.
 */
export function parseInline(text: string, opts?: ParseInlineOptions): MdInlineNode[] {
  const linkPolicy = opts?.linkPolicy ?? safeLinkHref;
  const out: MdInlineNode[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE_RE.exec(rest);
    if (!m) {
      out.push({ t: 'text', text: rest });
      break;
    }
    if (m.index > 0) out.push({ t: 'text', text: rest.slice(0, m.index) });
    if (m[1]) out.push({ t: 'code', text: m[2] });
    else if (m[3]) out.push({ t: 'strong', children: parseInline(m[4], opts) });
    else if (m[5]) out.push({ t: 'em', children: parseInline(m[6], opts) });
    else if (m[7]) out.push({ t: 'em', children: parseInline(m[8], opts) });
    else {
      const href = linkPolicy(m[11]);
      // A policy-rejected href (unsafe scheme, over a link-count budget, …)
      // renders the whole construct as literal text — visibly not a link,
      // nothing to click.
      if (href) out.push({ t: 'link', href, children: parseInline(m[10], opts) });
      else out.push({ t: 'text', text: m[9] });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * Parse `text` into the block AST above. Never throws; null/empty → [].
 * Line-based: headings and list items are single lines; consecutive plain
 * lines merge into one paragraph (joined with a space); blank lines separate
 * blocks. List type switches (ul ↔ ol) start a new list.
 */
export function parseMarkdown(text?: string | null): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = []; // pending paragraph lines
  const flushPara = (): void => {
    if (para.length) {
      blocks.push({ t: 'p', children: parseInline(para.join(' ')) });
      para = [];
    }
  };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { flushPara(); continue; }
    const hm = HEADING_RE.exec(line);
    if (hm) {
      flushPara();
      blocks.push({ t: 'h', level: hm[1].length, children: parseInline(hm[2]) });
      continue;
    }
    const um = UL_RE.exec(line);
    const om = um ? null : OL_RE.exec(line);
    if (um || om) {
      flushPara();
      const t = um ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      const list: MdListBlock = last && last.t === t ? last : { t, items: [] };
      if (list !== last) blocks.push(list);
      list.items.push(parseInline((um || om)![1]));
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}
