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
import { parseInline, parseMarkdown, safeLinkHref } from '../../src/core/markdown-lite.js';

const text = (s: string): DocInline => ({ kind: 'text', text: s });

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

  it('bold, emphasis, and inline code render flattened (no nested children)', () => {
    const r = parseDocMarkdown('a **b** *c* `d`');
    expect(r.blocks).toEqual([
      {
        kind: 'paragraph',
        inline: [
          text('a '),
          { kind: 'strong', text: 'b' },
          text(' '),
          { kind: 'em', text: 'c' },
          text(' '),
          { kind: 'code', text: 'd' },
        ],
      },
    ]);
  });

  it('bold nesting italic flattens to plain text', () => {
    const r = parseDocMarkdown('**a *b***');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [{ kind: 'strong', text: 'a b' }] }]);
  });

  it('unordered lists', () => {
    const r = parseDocMarkdown('- a\n* b');
    expect(r.blocks).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [{ inline: [text('a')] }, { inline: [text('b')] }] },
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
          { kind: 'link', text: 'docs', href: 'https://clickhouse.com/docs/x' },
          text(' and '),
          { kind: 'link', text: 'rel', href: 'https://clickhouse.com/docs/sql-reference/functions' },
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

  it('a thematic break terminates a pending paragraph', () => {
    const r = parseDocMarkdown('body\n---\nafter');
    expect(r.blocks.map((b) => b.kind)).toEqual(['paragraph', 'break', 'paragraph']);
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
        rows: [[[{ kind: 'strong', text: 'x' }], [{ kind: 'code', text: 'y' }]]],
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

  it('a non-pipe line ends the table rows without consuming a blank line', () => {
    const r = parseDocMarkdown('| a |\n| --- |\n| 1 |\nafter');
    expect(r.blocks).toEqual([
      { kind: 'table', header: [[text('a')]], rows: [[[text('1')]]] },
      { kind: 'paragraph', inline: [text('after')] },
    ]);
  });
});

describe('parseDocMarkdown — literal preservation', () => {
  it('raw HTML tags stay literal text', () => {
    const r = parseDocMarkdown('<script>alert(1)</script>');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('<script>alert(1)</script>')] }]);
  });

  it('images stay literal (never become a link)', () => {
    const r = parseDocMarkdown('![alt text](https://example.com/img.png)');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('![alt text](https://example.com/img.png)')] }]);
  });

  it('reference-style links stay literal', () => {
    const r = parseDocMarkdown('[text][ref]');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('[text][ref]')] }]);
  });

  it('setext-style underlines do not become headings', () => {
    const r = parseDocMarkdown('Title\n===');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('Title ===')] }]);
    // A `---` underline collides with the thematic-break rule instead —
    // still never a heading, which is the only thing #315 requires.
    const r2 = parseDocMarkdown('Title\n---');
    expect(r2.blocks.some((b) => b.kind === 'heading')).toBe(false);
  });

  it('unbalanced emphasis stays literal', () => {
    const r = parseDocMarkdown('**bold without close');
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [text('**bold without close')] }]);
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
    expect(r.blocks).toEqual([{ kind: 'paragraph', inline: [{ kind: 'link', text: 'x', href: 'https://mapped.example/x' }] }]);
  });

  it('further links beyond MAX_DOC_LINKS render as plain text', () => {
    const n = MAX_DOC_LINKS + 5;
    const md = Array.from({ length: n }, (_, i) => `[l${i}](https://clickhouse.com/docs/${i})`).join(' ');
    const r = parseDocMarkdown(md);
    const inline = (r.blocks[0] as { inline: DocInline[] }).inline;
    const links = inline.filter((n2) => n2.kind === 'link');
    const rejectedAsText = inline.filter((n2) => n2.kind === 'text' && /^\[l\d+\]/.test(n2.text));
    expect(links.length).toBe(MAX_DOC_LINKS);
    expect(rejectedAsText.length).toBe(5);
  });
});

describe('parseDocMarkdown — limits', () => {
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

// ── markdown-lite.ts: newly-exported `parseInline` API (unchanged internals,
// additive coverage only — parseMarkdown's own tests are untouched below) ──
describe('markdown-lite parseInline (newly exported, with an injected linkPolicy)', () => {
  it('defaults to safeLinkHref (http/https) when no options are given, matching parseMarkdown', () => {
    expect(parseInline('[x](https://example.com)')).toEqual([
      { t: 'link', href: 'https://example.com', children: [{ t: 'text', text: 'x' }] },
    ]);
  });

  it('accepts an injected linkPolicy that overrides the default', () => {
    const policy = (href: string): string | null => (href === 'ok' ? 'https://mapped' : null);
    expect(parseInline('[a](ok)', { linkPolicy: policy })).toEqual([
      { t: 'link', href: 'https://mapped', children: [{ t: 'text', text: 'a' }] },
    ]);
    expect(parseInline('[a](rejected)', { linkPolicy: policy })).toEqual([{ t: 'text', text: '[a](rejected)' }]);
  });

  it('propagates the injected policy into nested bold/italic content', () => {
    const policy = (): string | null => 'https://always';
    expect(parseInline('**[a](x)**', { linkPolicy: policy })).toEqual([
      { t: 'strong', children: [{ t: 'link', href: 'https://always', children: [{ t: 'text', text: 'a' }] }] },
    ]);
  });

  it('an image marker is never mistaken for a link (shared regex fix)', () => {
    expect(parseInline('![alt](https://example.com/x.png)')).toEqual([
      { t: 'text', text: '![alt](https://example.com/x.png)' },
    ]);
  });
});

// Sanity: markdown-lite's own default profile (safeLinkHref, http-or-https)
// is unaffected by doc-markdown's stricter default — imported here only to
// prove both modules coexist against the one shared regex/tokenizer.
describe('markdown-lite parseMarkdown / safeLinkHref — unaffected by doc-markdown', () => {
  it('still allows http (not just https), unlike doc-markdown default policy', () => {
    expect(safeLinkHref('http://example.com')).toBe('http://example.com');
    const blocks = parseMarkdown('[x](http://example.com)');
    expect(blocks).toEqual([
      { t: 'p', children: [{ t: 'link', href: 'http://example.com', children: [{ t: 'text', text: 'x' }] }] },
    ]);
  });
});
