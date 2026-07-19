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
// considered and rejected for a niche panel (hard rule 4: no new runtime dep
// — an owner decision later amended THIS constraint, but only for #315's
// `core/doc-markdown.ts`; this module's own "no new dep" scope is unchanged).
//
// HISTORY: #315 briefly lifted `parseInline` out to a private-to-exported
// function with an injected `linkPolicy` option so `doc-markdown.ts` could
// reuse this exact tokenizer/regex for its own (stricter) inline spans,
// rather than forking it. `doc-markdown.ts` has since moved to `marked`'s own
// lexer (owner decision amending #315's original non-goal) and no longer
// imports anything from this module — with zero other consumers of the
// lifted shape, this module reverts to its original, simpler pre-lift form
// (a private `parseInline`, no `ParseInlineOptions`/injected policy). This
// file's own behavior and tests are unchanged either way.
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
// italic) via the `[^*]|\*[^*]+\*` alternation.
const INLINE_RE = /(`([^`]+)`)|(\*\*((?:[^*]|\*[^*]+\*)+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)|(\[([^\]]+)\]\(([^)\s]+)\))/;

/** Only http(s) URLs may become real links; anything else stays text. */
export function safeLinkHref(href: string): string | null {
  return /^https?:\/\//i.test(href) ? href : null;
}

// Parse one line's inline formatting into inline nodes.
function parseInline(text: string): MdInlineNode[] {
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
    else if (m[3]) out.push({ t: 'strong', children: parseInline(m[4]) });
    else if (m[5]) out.push({ t: 'em', children: parseInline(m[6]) });
    else if (m[7]) out.push({ t: 'em', children: parseInline(m[8]) });
    else {
      const href = safeLinkHref(m[11]);
      // An unsafe scheme (javascript:, data:, …) renders the whole construct
      // as literal text — visibly not a link, nothing to click.
      if (href) out.push({ t: 'link', href, children: parseInline(m[10]) });
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
