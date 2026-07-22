import { describe, it, expect } from 'vitest';
import {
  parseDocMarkdown,
  clickhouseDocUrl,
  defaultDocLinkPolicy,
  latestDocUrlFromSource,
  MAX_DOC_MARKDOWN_BYTES,
  MAX_DOC_AST_NODES,
  MAX_DOC_NESTING_DEPTH,
  MAX_DOC_CODE_BLOCK_BYTES,
  MAX_DOC_LINKS,
} from '../../src/core/doc-markdown.js';
import type { DocBlock, DocInline } from '../../src/core/doc-markdown.js';

const text = (s: string): DocInline => ({ kind: 'text', text: s });
const code = (s: string): DocInline => ({ kind: 'code', text: s });
const strong = (...children: DocInline[]): DocInline => ({ kind: 'strong', children });
const em = (...children: DocInline[]): DocInline => ({ kind: 'em', children });
const del = (...children: DocInline[]): DocInline => ({ kind: 'del', children });
const link = (href: string, ...children: DocInline[]): DocInline => ({ kind: 'link', href, children });

describe('limit constants', () => {
  it('match #315', () => {
    expect(MAX_DOC_MARKDOWN_BYTES).toBe(1_000_000);
    expect(MAX_DOC_AST_NODES).toBe(20_000);
    expect(MAX_DOC_NESTING_DEPTH).toBe(16);
    expect(MAX_DOC_CODE_BLOCK_BYTES).toBe(250_000);
    expect(MAX_DOC_LINKS).toBe(1_000);
  });
});

describe('clickhouseDocUrl', () => {
  it('maps a clean relative path', () => {
    expect(clickhouseDocUrl('sql-reference/functions')).toBe('https://clickhouse.com/docs/sql-reference/functions');
  });
  it('strips a leading slash and collapses repeated slashes', () => {
    expect(clickhouseDocUrl('/sql-reference//functions')).toBe('https://clickhouse.com/docs/sql-reference/functions');
  });
  it('rejects a path with a scheme, protocol-relative host, or traversal', () => {
    expect(clickhouseDocUrl('https://example.com/x')).toBeNull();
    expect(clickhouseDocUrl('//example.com/x')).toBeNull();
    expect(clickhouseDocUrl('../../etc/passwd')).toBeNull();
    expect(clickhouseDocUrl('a/../b')).toBeNull();
  });
  it('rejects empty/blank input and a path that cleans to empty', () => {
    expect(clickhouseDocUrl('')).toBeNull();
    expect(clickhouseDocUrl('   ')).toBeNull();
    expect(clickhouseDocUrl('/')).toBeNull();
  });
  it('rejects non-string input', () => {
    expect(clickhouseDocUrl(123 as unknown as string)).toBeNull();
  });
});

describe('defaultDocLinkPolicy', () => {
  it('passes absolute https URLs through unchanged', () => {
    expect(defaultDocLinkPolicy('https://clickhouse.com/docs/x')).toBe('https://clickhouse.com/docs/x');
  });
  it('rejects http, javascript:, data:, and protocol-relative URLs', () => {
    expect(defaultDocLinkPolicy('http://example.com')).toBeNull();
    expect(defaultDocLinkPolicy('javascript:alert(1)')).toBeNull();
    expect(defaultDocLinkPolicy('data:text/html,x')).toBeNull();
    expect(defaultDocLinkPolicy('//example.com')).toBeNull();
  });
  it('routes a scheme-less relative path through clickhouseDocUrl', () => {
    expect(defaultDocLinkPolicy('sql-reference/statements/select')).toBe(
      'https://clickhouse.com/docs/sql-reference/statements/select',
    );
    expect(defaultDocLinkPolicy('../escape')).toBeNull();
  });
  it('rejects empty/non-string input', () => {
    expect(defaultDocLinkPolicy('')).toBeNull();
    expect(defaultDocLinkPolicy(null as unknown as string)).toBeNull();
  });
});

describe('latestDocUrlFromSource', () => {
  it('maps a docs/ + .md source path', () => {
    expect(latestDocUrlFromSource('docs/sql-reference/functions/x.md'))
      .toBe('https://clickhouse.com/docs/sql-reference/functions/x');
  });
  it('strips an en/ locale segment', () => {
    expect(latestDocUrlFromSource('docs/en/sql-reference/functions/x.md'))
      .toBe('https://clickhouse.com/docs/sql-reference/functions/x');
  });
  it('rejects a path with no docs/ prefix', () => {
    expect(latestDocUrlFromSource('sql-reference/functions/x.md')).toBeNull();
  });
  it('rejects a path with no .md suffix', () => {
    expect(latestDocUrlFromSource('docs/sql-reference/functions/x')).toBeNull();
  });
  it('rejects a traversal segment even after prefix/suffix match', () => {
    expect(latestDocUrlFromSource('docs/en/../../etc/passwd.md')).toBeNull();
  });
  it('rejects an absolute URL', () => {
    expect(latestDocUrlFromSource('https://clickhouse.com/docs/x.md')).toBeNull();
  });
  it('rejects undefined, null, and non-string input', () => {
    expect(latestDocUrlFromSource(undefined)).toBeNull();
    expect(latestDocUrlFromSource(null)).toBeNull();
    expect(latestDocUrlFromSource(123 as unknown as string)).toBeNull();
  });
});

describe('parseDocMarkdown — supported constructs', () => {
  it('paragraphs', () => {
    expect(parseDocMarkdown('one\ntwo\n\nthree')).toEqual({
      blocks: [
        { kind: 'paragraph', inline: [text('one two')] },
        { kind: 'paragraph', inline: [text('three')] },
      ],
      truncated: false,
    });
  });

  it('ATX headings 1–6; 7+ hashes is a paragraph', () => {
    const r1 = parseDocMarkdown('# Title');
    expect(r1.blocks).toEqual([{ kind: 'heading', level: 1, inline: [text('Title')] }]);
    const r6 = parseDocMarkdown('###### Deep');
    expect(r6.blocks).toEqual([{ kind: 'heading', level: 6, inline: [text('Deep')] }]);
    const r7 = parseDocMarkdown('####### Not');
    expect(r7.blocks[0].kind).toBe('paragraph');
  });

  it('a heading whose ENTIRE text is just the Docusaurus anchor suffix strips to an empty inline array', () => {
    const r = parseDocMarkdown('## {#anchor}');
    expect(r.blocks).toEqual([{ kind: 'heading', level: 2, inline: [] }]);
  });

  it('a heading with prose plus a trailing Docusaurus anchor strips just the suffix, keeping the prose', () => {
    const r = parseDocMarkdown('## Title {#my-anchor}');
    expect(r.blocks).toEqual([{ kind: 'heading', level: 2, inline: [text('Title')] }]);
  });

  it('a GFM task-list item: the checkbox marker (beyond this module\'s subset) surfaces as literal nested text, never dropped', () => {
    const r = parseDocMarkdown('- [ ] task');
    expect(r.blocks).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          {
            inline: [text('task')],
            children: [{ kind: 'paragraph', inline: [text('[ ] ')] }],
          },
        ],
      },
    ]);
  });

  it('bold, emphasis, and inline code render as their own inline node kinds', () => {
    const r = parseDocMarkdown('a **b** *c* `d`');
    expect(r.blocks).toEqual([
      {
        kind: 'paragraph',
        inline: [
          text('a '),
          strong(text('b')),
          text(' '),
          em(text('c')),
          text(' '),
          code('d'),
        ],
      },
    ]);
  });

  it('UPGRADE: bold nesting italic stays a real nested tree (**a *b*** -> strong containing text + em), not flattened to plain text', () => {
    const r = parseDocMarkdown('**a *b***');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [strong(text('a '), em(text('b')))] }]);
  });

  it('unordered lists (same bullet char)', () => {
    const r = parseDocMarkdown('- a\n- b');
    expect(r.blocks).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('a')] }, { inline: [text('b')] }] },
    ]);
  });

  it('UPGRADE: a bullet-CHARACTER switch (- vs *) starts a new list too (real CommonMark rule; the old hand-parser only split on ordered vs unordered)', () => {
    const r = parseDocMarkdown('- a\n* b');
    expect(r.blocks).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('a')] }] },
      { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('b')] }] },
    ]);
  });

  it('ordered lists track the start number', () => {
    const r = parseDocMarkdown('5. a\n6. b');
    expect(r.blocks).toEqual([
      { kind: 'list', ordered: true, start: 5, items: [{ inline: [text('a')] }, { inline: [text('b')] }] },
    ]);
  });

  it('a marker-family switch starts a new list', () => {
    const r = parseDocMarkdown('- a\n1. b');
    expect(r.blocks.map((b) => b.kind)).toEqual(['list', 'list']);
    expect((r.blocks[0] as { ordered: boolean }).ordered).toBe(false);
    expect((r.blocks[1] as { ordered: boolean }).ordered).toBe(true);
  });

  it('nested lists (indent-based)', () => {
    const r = parseDocMarkdown('- a\n  - a1\n  - a2\n- b');
    expect(r.blocks).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          {
            inline: [text('a')],
            children: [
              { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('a1')] }, { inline: [text('a2')] }] },
            ],
          },
          { inline: [text('b')] },
        ],
      },
    ]);
  });

  it('a blank line ends a list (no loose-list support); the paragraph after starts a new block', () => {
    const r = parseDocMarkdown('- a\n- b\n\nafter');
    expect(r.blocks).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('a')] }, { inline: [text('b')] }] },
      { kind: 'paragraph', inline: [text('after')] },
    ]);
  });

  it('a nested-list item may carry two sibling nested sub-lists (marker switch under the same parent item)', () => {
    const r = parseDocMarkdown('- a\n  - b1\n  1. b2');
    expect(r.blocks).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          {
            inline: [text('a')],
            children: [
              { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('b1')] }] },
              { kind: 'list', ordered: true, start: 1, items: [{ inline: [text('b2')] }] },
            ],
          },
        ],
      },
    ]);
  });

  it('fenced code blocks preserve content exactly, with and without a language tag', () => {
    const withLang = parseDocMarkdown('```sql\nSELECT 1;\n  indented\n```');
    expect(withLang.blocks).toEqual([{ kind: 'code', language: 'sql', text: 'SELECT 1;\n  indented' }]);
    const noLang = parseDocMarkdown('```\nplain\n```');
    expect(noLang.blocks).toEqual([{ kind: 'code', language: null, text: 'plain' }]);
  });

  it('fenced code blocks never inline-parse their content', () => {
    const r = parseDocMarkdown('```\n**not bold** [not](https://x)\n```');
    expect(r.blocks).toEqual([{ kind: 'code', language: null, text: '**not bold** [not](https://x)' }]);
  });

  it('unterminated fence runs to EOF as a code block (documented choice)', () => {
    const r = parseDocMarkdown('```js\nfoo\nbar');
    expect(r.blocks).toEqual([{ kind: 'code', language: 'js', text: 'foo\nbar' }]);
  });

  it('Markdown links: https absolute passes; relative maps via clickhouseDocUrl', () => {
    const r = parseDocMarkdown('see [docs](https://clickhouse.com/docs/x) and [rel](sql-reference/functions)');
    expect(r.blocks).toEqual([
      {
        kind: 'paragraph',
        inline: [
          text('see '),
          link('https://clickhouse.com/docs/x', text('docs')),
          text(' and '),
          link('https://clickhouse.com/docs/sql-reference/functions', text('rel')),
        ],
      },
    ]);
  });

  it('thematic breaks: ---, ***, ___', () => {
    expect(parseDocMarkdown('---').blocks).toEqual([{ kind: 'break' }]);
    expect(parseDocMarkdown('***').blocks).toEqual([{ kind: 'break' }]);
    expect(parseDocMarkdown('___').blocks).toEqual([{ kind: 'break' }]);
    expect(parseDocMarkdown('- - -').blocks).toEqual([{ kind: 'break' }]);
  });

  it('a thematic break (separated by a blank line so it cannot read as a setext underline) terminates a pending paragraph', () => {
    const r = parseDocMarkdown('body\n\n---\n\nafter');
    expect(r.blocks.map((b) => b.kind)).toEqual(['paragraph', 'break', 'paragraph']);
  });

  it('UPGRADE: text immediately followed by --- (no blank line) is a setext heading, not text + thematic-break (real CommonMark precedence; the old hand-parser read this as `body` then a break)', () => {
    const r = parseDocMarkdown('body\n---\nafter');
    expect(r.blocks).toEqual([
      { kind: 'heading', level: 2, inline: [text('body')] },
      { kind: 'paragraph', inline: [text('after')] },
    ]);
  });

  it('simple block quotes', () => {
    const r = parseDocMarkdown('> a\n> b');
    expect(r.blocks).toEqual([{ kind: 'quote', blocks: [{ kind: 'paragraph', inline: [text('a b')] }] }]);
  });

  it('nested block quotes (single extra level)', () => {
    const r = parseDocMarkdown('> outer\n> > inner');
    expect(r.blocks).toEqual([
      {
        kind: 'quote',
        blocks: [
          { kind: 'paragraph', inline: [text('outer')] },
          { kind: 'quote', blocks: [{ kind: 'paragraph', inline: [text('inner')] }] },
        ],
      },
    ]);
  });

  it('simple tables', () => {
    const r = parseDocMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    expect(r.blocks).toEqual([
      {
        kind: 'table',
        header: [[text('a')], [text('b')]],
        rows: [
          [[text('1')], [text('2')]],
          [[text('3')], [text('4')]],
        ],
      },
    ]);
  });

  it('table cells get inline parsing', () => {
    const r = parseDocMarkdown('| a | b |\n| --- | --- |\n| **x** | `y` |');
    expect(r.blocks).toEqual([
      {
        kind: 'table',
        header: [[text('a')], [text('b')]],
        rows: [[[strong(text('x'))], [code('y')]]],
      },
    ]);
  });

  it('a malformed table (mismatched separator columns) falls back to paragraph text', () => {
    const r = parseDocMarkdown('| a | b |\n| --- |');
    expect(r.blocks[0].kind).toBe('paragraph');
  });

  it('a malformed table (no separator row at all) falls back to paragraph text', () => {
    const r = parseDocMarkdown('| a | b |\nnot a separator');
    expect(r.blocks[0].kind).toBe('paragraph');
  });

  it('a malformed table (separator cells not dash runs) falls back to paragraph text', () => {
    const r = parseDocMarkdown('| a | b |\n| xx | yy |');
    expect(r.blocks[0].kind).toBe('paragraph');
  });

  it('a table as the very last two lines with no data rows', () => {
    const r = parseDocMarkdown('| a |\n| --- |');
    expect(r.blocks).toEqual([{ kind: 'table', header: [[text('a')]], rows: [] }]);
  });

  it('a blank line ends the table rows', () => {
    const r = parseDocMarkdown('| a |\n| --- |\n| 1 |\n\nafter');
    expect(r.blocks).toEqual([
      { kind: 'table', header: [[text('a')]], rows: [[[text('1')]]] },
      { kind: 'paragraph', inline: [text('after')] },
    ]);
  });

  it('UPGRADE: a bare non-pipe line still continues the table as a single-cell row (real GFM table-continuation rule; the old hand-parser required a `|` to keep reading rows)', () => {
    const r = parseDocMarkdown('| a |\n| --- |\n| 1 |\nafter');
    expect(r.blocks).toEqual([
      { kind: 'table', header: [[text('a')]], rows: [[[text('1')]], [[text('after')]]] },
    ]);
  });
});

describe('parseDocMarkdown — recursive inline nesting (owner decision: DocInline mirrors marked\'s inline tree 1:1)', () => {
  it('a link keeps its own inline formatting as real nested children (link containing code)', () => {
    const r = parseDocMarkdown('[see `code`](https://clickhouse.com/docs/x)');
    expect(r.blocks).toEqual([
      { kind: 'paragraph', inline: [link('https://clickhouse.com/docs/x', text('see '), code('code'))] },
    ]);
  });

  it('bold containing a link renders a real link node inside the strong node', () => {
    const r = parseDocMarkdown('**see [x](https://clickhouse.com/docs/x)**');
    expect(r.blocks).toEqual([
      { kind: 'paragraph', inline: [strong(text('see '), link('https://clickhouse.com/docs/x', text('x')))] },
    ]);
  });

  it('a policy-rejected link inside bold degrades to literal text INSIDE the strong node (the strong itself stays real)', () => {
    const r = parseDocMarkdown('**see [x](javascript:alert(1))**');
    expect(r.blocks).toEqual([
      { kind: 'paragraph', inline: [strong(text('see '), text('[x](javascript:alert(1))'))] },
    ]);
  });

  it('strikethrough (del) is a real recursive node, not degraded to plain text', () => {
    const r = parseDocMarkdown('~~gone~~ and ~~**bold gone**~~');
    expect(r.blocks).toEqual([
      { kind: 'paragraph', inline: [del(text('gone')), text(' and '), del(strong(text('bold gone')))] },
    ]);
  });

  it('MAX_DOC_NESTING_DEPTH: inline formatting nested past the bound degrades to one literal text leaf (its own further formatting flattened to plain text, never dropped)', () => {
    // Alternating `**`/`*` (strong/em) wrappers nest properly under marked's
    // flanking rules (same-delimiter-repeated does NOT nest — verified
    // against the real lexer), giving genuine deep inline nesting to bound.
    // The innermost content is deliberately rich (hard break, codespan, raw
    // HTML, an image, a link, and one more level of `em`) so the degrade
    // path (`flattenTokensToText`) exercises every one of its own cases too.
    const levels = MAX_DOC_NESTING_DEPTH + 5;
    let md = 'x  \ny `c` <i>h</i> ![z](https://a) [w](https://b) *e*';
    for (let i = 0; i < levels; i++) md = i % 2 === 0 ? `**${md}**` : `*${md}*`;
    const r = parseDocMarkdown(md);

    const inline = (r.blocks[0] as { inline: DocInline[] }).inline;
    let depth = 0;
    let node: DocInline = inline[0];
    while (node.kind === 'em' || node.kind === 'strong') {
      depth++;
      node = node.children[0];
    }
    expect(depth).toBeLessThanOrEqual(MAX_DOC_NESTING_DEPTH);
    expect(node.kind).toBe('text');
    // Every flattened construct's plain-text contribution survives: the hard
    // break and hyphen become spaces, the codespan/HTML/image/link/em all
    // contribute their own text, nothing is silently dropped.
    expect(node).toEqual(text('x y c <i>h</i> ![z](https://a) w e'));
  });

  it('MAX_DOC_NESTING_DEPTH: a policy-APPROVED link nested exactly at the bound stays a real link node, with its own (deeper) content flattened to one text child', () => {
    // 20 alternating strong/em wraps around the link happens to land the
    // link's own inline depth exactly at the bound (empirically verified
    // against the real lexer) — the LINK ITSELF must stay a real, safe
    // `link` node (never flattened away) while its OWN content (which would
    // nest one level deeper still) degrades to a single text child.
    let md = '[see `code`](https://clickhouse.com/docs/x)';
    for (let i = 0; i < 20; i++) md = i % 2 === 0 ? `**${md}**` : `*${md}*`;
    const r = parseDocMarkdown(md);

    const inline = (r.blocks[0] as { inline: DocInline[] }).inline;
    let node: DocInline = inline[0];
    while (node.kind === 'em' || node.kind === 'strong') node = node.children[0];
    expect(node).toEqual(link('https://clickhouse.com/docs/x', text('see code')));
  });
});

describe('parseDocMarkdown — literal preservation', () => {
  it('raw HTML tags stay literal text', () => {
    const r = parseDocMarkdown('<script>alert(1)</script>');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('<script>alert(1)</script>')] }]);
  });

  it('inline raw HTML (a span-level tag inside a paragraph) stays literal text', () => {
    const r = parseDocMarkdown('hello <b>world</b> tag');
    expect(r.blocks).toEqual([
      { kind: 'paragraph', inline: [text('hello '), text('<b>'), text('world'), text('</b>'), text(' tag')] },
    ]);
  });

  it('images stay literal (never become a link) — marked `image` token', () => {
    const r = parseDocMarkdown('![alt text](https://example.com/img.png)');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('![alt text](https://example.com/img.png)')] }]);
  });

  it('a reference-style link with NO matching definition stays literal (marked leaves it untokenized)', () => {
    const r = parseDocMarkdown('[text][ref]');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('[text][ref]')] }]);
  });

  it('unbalanced emphasis stays literal', () => {
    const r = parseDocMarkdown('**bold without close');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('**bold without close')] }]);
  });
});

describe('parseDocMarkdown — behavior upgrades from the marked lexer (deliberate, tested)', () => {
  it('UPGRADE: setext headings (Title\\n===) now parse as real headings (the hand-written parser left these literal)', () => {
    const r1 = parseDocMarkdown('Title\n===');
    expect(r1.blocks).toEqual([{ kind: 'heading', level: 1, inline: [text('Title')] }]);
    const r2 = parseDocMarkdown('Title\n---');
    expect(r2.blocks).toEqual([{ kind: 'heading', level: 2, inline: [text('Title')] }]);
  });

  it('UPGRADE: a reference-style link WITH a matching definition now resolves, through the same link policy', () => {
    const approved = parseDocMarkdown('[text][ref]\n\n[ref]: https://clickhouse.com/docs/x');
    expect(approved.blocks).toEqual([
      { kind: 'paragraph', inline: [link('https://clickhouse.com/docs/x', text('text'))] },
    ]);
    // The def points at an http (not https) URL — the default policy rejects
    // it exactly like a direct inline link, literal fallback to the raw
    // reference-style construct (never the resolved-but-rejected href).
    const rejected = parseDocMarkdown('[text][ref]\n\n[ref]: http://example.com');
    expect(rejected.blocks).toEqual([{ kind: 'paragraph', inline: [text('[text][ref]')] }]);
  });

  it('UPGRADE: loose lists (blank line between items) now parse as a list, not list + paragraph', () => {
    const r = parseDocMarkdown('- a\n\n- b');
    expect(r.blocks).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('a')] }, { inline: [text('b')] }] },
    ]);
  });
});

describe('parseDocMarkdown — Docusaurus admonitions', () => {
  it('each recognized variant (tip/note/info/warning/danger/important)', () => {
    for (const variant of ['tip', 'note', 'info', 'warning', 'danger', 'important']) {
      const r = parseDocMarkdown(`:::${variant}\nbody text\n:::`);
      expect(r.blocks).toEqual([
        { kind: 'admonition', variant, title: null, blocks: [{ kind: 'paragraph', inline: [text('body text')] }] },
      ]);
    }
  });

  it('an optional title after the variant', () => {
    const r = parseDocMarkdown(':::tip My Title\nbody\n:::');
    expect(r.blocks).toEqual([
      { kind: 'admonition', variant: 'tip', title: 'My Title', blocks: [{ kind: 'paragraph', inline: [text('body')] }] },
    ]);
  });

  it('an unrecognized :::kind is not treated as a container (falls through to marked as literal-ish paragraph text)', () => {
    const r = parseDocMarkdown(':::notarealvariant\nbody\n:::');
    expect(r.blocks.every((b) => b.kind !== 'admonition')).toBe(true);
  });

  it('nested block content inside an admonition (heading, list, code)', () => {
    const r = parseDocMarkdown(':::note\n## Heading\n- a\n- b\n\n```\ncode\n```\n:::');
    expect(r.blocks).toEqual([
      {
        kind: 'admonition',
        variant: 'note',
        title: null,
        blocks: [
          { kind: 'heading', level: 2, inline: [text('Heading')] },
          { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('a')] }, { inline: [text('b')] }] },
          { kind: 'code', language: null, text: 'code' },
        ],
      },
    ]);
  });

  it('an unterminated ::: opener never swallows content — renders as one literal text block', () => {
    const r = parseDocMarkdown('before\n\n:::tip\nnever closed');
    expect(r.blocks).toEqual([
      { kind: 'paragraph', inline: [text('before')] },
      { kind: 'paragraph', inline: [text(':::tip\nnever closed')] },
    ]);
  });

  it('a ::: line inside a fenced code block is never mistaken for an admonition boundary', () => {
    const r = parseDocMarkdown('```\n:::tip\nnot an admonition\n:::\n```');
    expect(r.blocks).toEqual([{ kind: 'code', language: null, text: ':::tip\nnot an admonition\n:::' }]);
  });

  it('fence tracking matches CommonMark length rules: a shorter inner run does not close a longer fence (review finding)', () => {
    // A 4-backtick fence containing a 3-backtick run and a ::: line — marked
    // treats the whole span as ONE code block; the pre-scan must agree, so
    // the admonition closes at the REAL bare ::: after the fence.
    const md = ':::tip\n````\n```\n:::\n```\n````\n:::\ntrailing paragraph after real close';
    const r = parseDocMarkdown(md);
    expect(r.blocks).toEqual([
      {
        kind: 'admonition', variant: 'tip', title: null,
        blocks: [{ kind: 'code', language: null, text: '```\n:::\n```' }],
      },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'trailing paragraph after real close' }] },
    ]);
  });

  it('a same-char run with a trailing suffix is content, not a closer; tildes do not close backtick fences', () => {
    const r = parseDocMarkdown(':::note\n```\n``` not-a-closer\n~~~\n:::\n```\n:::');
    expect(r.blocks).toEqual([
      {
        kind: 'admonition', variant: 'note', title: null,
        blocks: [{ kind: 'code', language: null, text: '``` not-a-closer\n~~~\n:::' }],
      },
    ]);
  });

  it('MAX_DOC_NESTING_DEPTH: a chain of nested admonitions flattens to literal text past the bound', () => {
    const levels = MAX_DOC_NESTING_DEPTH + 3;
    let md = 'deepest';
    for (let i = 0; i < levels; i++) md = `:::note\n${md}\n:::`;
    const r = parseDocMarkdown(md);

    let depth = 0;
    let node: DocBlock = r.blocks[0];
    while (node.kind === 'admonition') {
      depth++;
      node = node.blocks[0];
    }
    expect(depth).toBeLessThanOrEqual(MAX_DOC_NESTING_DEPTH);
    expect(JSON.stringify(r.blocks)).toContain('deepest');
  });
});

describe('parseDocMarkdown — link policy', () => {
  it('rejects http (only https passes by default)', () => {
    const r = parseDocMarkdown('[x](http://example.com)');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('[x](http://example.com)')] }]);
  });

  it('rejects javascript: and data: schemes', () => {
    expect(parseDocMarkdown('[x](javascript:alert1)').blocks).toEqual([
      { kind: 'paragraph', inline: [text('[x](javascript:alert1)')] },
    ]);
    expect(parseDocMarkdown('[x](data:text/html,y)').blocks).toEqual([
      { kind: 'paragraph', inline: [text('[x](data:text/html,y)')] },
    ]);
  });

  it('rejects a `..` traversal in a relative link', () => {
    const r = parseDocMarkdown('[x](../../escape)');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('[x](../../escape)')] }]);
  });

  it('accepts a custom injected linkPolicy', () => {
    const r = parseDocMarkdown('[x](anything)', { linkPolicy: () => 'https://mapped.example/x' });
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [link('https://mapped.example/x', text('x'))] }]);
  });

  it('further links beyond MAX_DOC_LINKS render as plain text', () => {
    const n = MAX_DOC_LINKS + 5;
    const md = Array.from({ length: n }, (_, i) => `[l${i}](https://clickhouse.com/docs/${i})`).join(' ');
    const r = parseDocMarkdown(md);
    const inline = (r.blocks[0] as { inline: DocInline[] }).inline;
    const links = inline.filter((n2) => n2.kind === 'link');
    const rejectedAsText = inline.filter((n2) => n2.kind === 'text' && /^\[l\d+\]/.test((n2 as { text: string }).text));
    expect(links.length).toBe(MAX_DOC_LINKS);
    expect(rejectedAsText.length).toBe(5);
  });
});

describe('parseDocMarkdown — limits', () => {
  it('does not strip an explicit-anchor-looking suffix hidden inside formatting', () => {
    expect(parseDocMarkdown('# title **bold {#kept}**').blocks[0]).toEqual({
      kind: 'heading', level: 1, inline: [text('title '), strong(text('bold {#kept}'))],
    });
  });

  it('MAX_DOC_MARKDOWN_BYTES: an oversized input is truncated and flagged', () => {
    const big = 'a'.repeat(MAX_DOC_MARKDOWN_BYTES + 10);
    const r = parseDocMarkdown(big);
    expect(r.truncated).toBe(true);
    expect(r.blocks.length).toBeGreaterThan(0);
  });

  it('an input at or under the byte cap is not flagged truncated (for that reason)', () => {
    const ok = 'a'.repeat(1000);
    const r = parseDocMarkdown(ok);
    expect(r.truncated).toBe(false);
  });

  it('MAX_DOC_AST_NODES: emission stops and truncated is set once the node budget is exhausted', () => {
    const md = Array.from({ length: 12_000 }, (_, i) => 'paragraph number ' + i).join('\n\n');
    const r = parseDocMarkdown(md);
    expect(r.truncated).toBe(true);
    expect(r.blocks.length).toBeLessThan(12_000);
  });

  it('MAX_DOC_AST_NODES: a single inline-heavy block can cross the budget by itself', () => {
    // One paragraph whose OWN inline parse emits far more than the node
    // budget in a single `parseInlineBudgeted` call (as opposed to crossing
    // it gradually, one block at a time).
    const md = '**b** '.repeat(MAX_DOC_AST_NODES);
    const r = parseDocMarkdown(md);
    expect(r.truncated).toBe(true);
    expect(r.blocks).toEqual([expect.objectContaining({ kind: 'paragraph' })]);
  });

  it('MAX_DOC_AST_NODES: a list with more items than the node budget stops enumerating items (not just their content) — regression for the mapList bypass', () => {
    // 25,000 tight list items is comfortably more than MAX_DOC_AST_NODES
    // (20,000): before the fix, `mapList` mapped every item unconditionally
    // via `.map`, so once the shared budget was exhausted each further item
    // still became an (empty-content) DocListItem — 25,000 of them, one per
    // <li> `doc-markdown-view.ts` would render. The fix bounds the item
    // COUNT itself, not just each item's inline content.
    const md = Array.from({ length: 25_000 }, () => '- x').join('\n');
    const r = parseDocMarkdown(md);
    expect(r.truncated).toBe(true);
    const list = r.blocks[0] as DocBlock & { kind: 'list' };
    expect(list.kind).toBe('list');
    // Bounded well under the source's 25,000 items, and consistent with the
    // shared MAX_DOC_AST_NODES budget (one count per item, plus the list
    // container itself and this doc's other blocks).
    expect(list.items.length).toBeLessThan(25_000);
    expect(list.items.length).toBeLessThanOrEqual(MAX_DOC_AST_NODES);
  });

  it('MAX_DOC_AST_NODES: a table with more rows than the node budget stops enumerating rows — regression for the mapTable bypass', () => {
    // Same bug, table shape: header + 25,000 one-cell rows. Before the fix,
    // `mapTable` mapped every row (and every cell) unconditionally via
    // `.map`, so exhausting the budget still produced 25,000 (empty-content)
    // rows — 25,000 <tr>s in `doc-markdown-view.ts`.
    const header = '| h |\n| --- |\n';
    const rows = Array.from({ length: 25_000 }, () => '| a |').join('\n');
    const r = parseDocMarkdown(header + rows);
    expect(r.truncated).toBe(true);
    const table = r.blocks[0] as DocBlock & { kind: 'table' };
    expect(table.kind).toBe('table');
    expect(table.rows.length).toBeLessThan(25_000);
    expect(table.rows.length).toBeLessThanOrEqual(MAX_DOC_AST_NODES);
  });

  it('MAX_DOC_AST_NODES: very wide tables stop enumerating header and row cells', () => {
    const wideHeader = `|${Array.from({ length: 11_000 }, () => 'h').join('|')}|`;
    const separator = `|${Array.from({ length: 11_000 }, () => '---').join('|')}|`;
    expect(parseDocMarkdown(`${wideHeader}\n${separator}`).truncated).toBe(true);

    const mediumHeader = `|${Array.from({ length: 8_000 }, () => '').join('|')}|`;
    const mediumSeparator = `|${Array.from({ length: 8_000 }, () => '---').join('|')}|`;
    const mediumRow = `|${Array.from({ length: 8_000 }, () => 'x').join('|')}|`;
    expect(parseDocMarkdown(`${mediumHeader}\n${mediumSeparator}\n${mediumRow}`).truncated).toBe(true);
  });

  it('MAX_DOC_AST_NODES: many admonition segments stop before parsing later segments', () => {
    const md = Array.from({ length: 8_000 }, () => ':::tip\nx\n:::').join('\n');
    expect(parseDocMarkdown(md).truncated).toBe(true);
  });

  it('a normal-sized list and table stay fully intact (unaffected by the budget-bypass fix)', () => {
    const r = parseDocMarkdown('- a\n- b\n- c\n\n| h1 | h2 |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    expect(r.truncated).toBe(false);
    expect(r.blocks).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('a')] }, { inline: [text('b')] }, { inline: [text('c')] }] },
      {
        kind: 'table',
        header: [[text('h1')], [text('h2')]],
        rows: [
          [[text('1')], [text('2')]],
          [[text('3')], [text('4')]],
        ],
      },
    ]);
  });

  it('MAX_DOC_NESTING_DEPTH: deeply nested lists flatten past the bound', () => {
    const levels = MAX_DOC_NESTING_DEPTH + 5;
    const lines: string[] = [];
    for (let i = 0; i < levels; i++) lines.push('  '.repeat(i) + '- level' + i);
    const r = parseDocMarkdown(lines.join('\n'));

    // Walk the list-nesting chain and confirm it never exceeds the bound.
    let depth = 0;
    let node = r.blocks[0] as DocBlock & { kind: 'list' };
    expect(node.kind).toBe('list');
    while (node.items[0]?.children) {
      depth++;
      node = node.items[0].children[0] as DocBlock & { kind: 'list' };
    }
    expect(depth).toBeLessThanOrEqual(MAX_DOC_NESTING_DEPTH);

    // The flattened tail must still be present somewhere as literal text.
    const flat = JSON.stringify(r.blocks);
    expect(flat).toContain('level' + (levels - 1));
  });

  it('MAX_DOC_NESTING_DEPTH: deeply nested quotes flatten to a literal paragraph past the bound', () => {
    const levels = MAX_DOC_NESTING_DEPTH + 5;
    const line = '> '.repeat(levels) + 'deep';
    const r = parseDocMarkdown(line);

    let depth = 0;
    let node: DocBlock = r.blocks[0];
    while (node.kind === 'quote') {
      depth++;
      node = node.blocks[0];
    }
    expect(depth).toBeLessThanOrEqual(MAX_DOC_NESTING_DEPTH);
  });

  it('MAX_DOC_CODE_BLOCK_BYTES: an oversized fenced code block is truncated and flagged on the node', () => {
    const big = 'x'.repeat(MAX_DOC_CODE_BLOCK_BYTES + 100);
    const r = parseDocMarkdown('```\n' + big + '\n```');
    const code = r.blocks[0] as DocBlock & { kind: 'code' };
    expect(code.kind).toBe('code');
    expect(code.truncated).toBe(true);
    expect(new TextEncoder().encode(code.text).length).toBeLessThanOrEqual(MAX_DOC_CODE_BLOCK_BYTES);
  });

  it('a code block at or under the byte cap is not flagged truncated', () => {
    const r = parseDocMarkdown('```\nshort\n```');
    const code = r.blocks[0] as DocBlock & { kind: 'code' };
    expect(code.truncated).toBeUndefined();
  });
});

describe('parseDocMarkdown — total-fallback contract', () => {
  it('never throws — a hostile linkPolicy is caught and the raw input is returned as one literal paragraph', () => {
    const raw = 'hello [x](https://y) world';
    let result: ReturnType<typeof parseDocMarkdown> | undefined;
    expect(() => {
      result = parseDocMarkdown(raw, {
        linkPolicy: () => {
          throw new Error('hostile policy');
        },
      });
    }).not.toThrow();
    expect(result).toEqual({ blocks: [{ kind: 'paragraph', inline: [text(raw)] }], truncated: false });
  });

  it('non-string input never throws', () => {
    expect(() => parseDocMarkdown(null as unknown as string)).not.toThrow();
    expect(() => parseDocMarkdown(undefined as unknown as string)).not.toThrow();
    expect(parseDocMarkdown(null as unknown as string)).toEqual({ blocks: [], truncated: false });
  });

  it('never throws even when the input itself throws on stringification (including inside the fallback path)', () => {
    const hostile = { toString: () => { throw new Error('boom'); } };
    let result: ReturnType<typeof parseDocMarkdown> | undefined;
    expect(() => {
      result = parseDocMarkdown(hostile as unknown as string);
    }).not.toThrow();
    expect(Array.isArray(result!.blocks)).toBe(true);
  });
});

describe('parseDocMarkdown — fuzz/property (fixed seed, deterministic)', () => {
  // mulberry32 — small deterministic PRNG so the fuzz run never varies
  // between test executions (no Math.random).
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ALPHABET =
    '#*_`[]()|->\n\r\t abc123 <script>NBSP ☃✓' + String.fromCharCode(0) + '😀';

  function randomString(rng: () => number, maxLen: number): string {
    const len = Math.floor(rng() * maxLen);
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    return s;
  }

  it('never throws and always returns the contract shape, across a few hundred seeded inputs', () => {
    const rng = mulberry32(0xC0FFEE);
    for (let i = 0; i < 300; i++) {
      const input = randomString(rng, 200);
      let result: ReturnType<typeof parseDocMarkdown> | undefined;
      expect(() => {
        result = parseDocMarkdown(input);
      }).not.toThrow();
      expect(Array.isArray(result!.blocks)).toBe(true);
      expect(typeof result!.truncated).toBe('boolean');
    }
  });

  it('never throws on pathological inputs (deep nesting, many links, huge lines)', () => {
    const rng = mulberry32(1234567);
    const pathological = [
      '- a\n  - b\n    - c\n      - d\n        - e\n          - f\n            - g\n              - h',
      '> '.repeat(40) + 'x',
      Array.from({ length: 50 }, (_, i) => `[l${i}](https://x/${i})`).join(''),
      '`'.repeat(500),
      '*'.repeat(500),
      '|'.repeat(200) + '\n' + '-'.repeat(200),
      '```' + 'a'.repeat(2000),
      randomString(rng, 5000),
    ];
    for (const input of pathological) {
      let result: ReturnType<typeof parseDocMarkdown> | undefined;
      expect(() => {
        result = parseDocMarkdown(input);
      }).not.toThrow();
      expect(Array.isArray(result!.blocks)).toBe(true);
    }
  });
});
