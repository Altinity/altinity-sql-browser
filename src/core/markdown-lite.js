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
export function safeLinkHref(href) {
  return /^https?:\/\//i.test(href) ? href : null;
}

// Parse one line's inline formatting into inline nodes.
function parseInline(text) {
  const out = [];
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
export function parseMarkdown(text) {
  const blocks = [];
  let para = []; // pending paragraph lines
  const flushPara = () => {
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
      const list = last && last.t === t ? last : { t, items: [] };
      if (list !== last) blocks.push(list);
      list.items.push(parseInline((um || om)[1]));
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}
