import { describe, it, expect, vi } from 'vitest';
import { renderDocMarkdown } from '../../src/ui/doc-markdown-view.js';
import type { DocMarkdownViewOptions } from '../../src/ui/doc-markdown-view.js';
import { parseDocMarkdown } from '../../src/core/doc-markdown.js';
import type { DocMarkdownResult } from '../../src/core/doc-markdown.js';
import type { CodeViewerHandle, CodeViewerOptions } from '../../src/editor/code-viewer.types.js';

function fakeViewer(): CodeViewerHandle {
  return { setText: vi.fn(), setLanguage: vi.fn(), setWrap: vi.fn(), focus: vi.fn(), destroy: vi.fn() };
}

function result(md: string): DocMarkdownResult {
  return parseDocMarkdown(md);
}

describe('renderDocMarkdown — block rendering', () => {
  it('headings offset by +3 and cap at h6, entry title stays the only h3', () => {
    const el = renderDocMarkdown(document, result('# one\n## two\n### three\n#### four\n##### five\n###### six'));
    const tags = [...el.children].map((c) => c.tagName.toLowerCase());
    expect(tags).toEqual(['h4', 'h5', 'h6', 'h6', 'h6', 'h6']);
    expect(el.querySelector('h3')).toBeNull();
  });

  it('renders a paragraph', () => {
    const el = renderDocMarkdown(document, result('hello world'));
    const p = el.querySelector('p.docs-md-p')!;
    expect(p.textContent).toBe('hello world');
  });

  it('renders unordered and ordered lists, ordered with a non-1 start attribute', () => {
    const el = renderDocMarkdown(document, result('- a\n- b'));
    expect(el.querySelector('ul.docs-md-list')).not.toBeNull();
    expect(el.querySelectorAll('li').length).toBe(2);

    const el2 = renderDocMarkdown(document, result('3. a\n4. b'));
    const ol = el2.querySelector('ol.docs-md-list') as HTMLOListElement;
    expect(ol).not.toBeNull();
    expect(ol.getAttribute('start')).toBe('3');
  });

  it('ordered list starting at 1 omits the start attribute', () => {
    const el = renderDocMarkdown(document, result('1. a\n2. b'));
    const ol = el.querySelector('ol.docs-md-list')!;
    expect(ol.hasAttribute('start')).toBe(false);
  });

  it('renders nested list items as a nested <ul>/<ol> inside the parent <li>', () => {
    const el = renderDocMarkdown(document, result('- a\n  - nested'));
    const li = el.querySelector('li.docs-md-li')!;
    const nested = li.querySelector('ul.docs-md-list');
    expect(nested).not.toBeNull();
    expect(nested!.textContent).toContain('nested');
  });

  it('renders a blockquote', () => {
    const el = renderDocMarkdown(document, result('> quoted text'));
    const q = el.querySelector('blockquote.docs-md-quote')!;
    expect(q.textContent).toContain('quoted text');
  });

  it('renders a thematic break as <hr>', () => {
    const el = renderDocMarkdown(document, result('para one\n\n---\n\npara two'));
    expect(el.querySelector('hr.docs-md-hr')).not.toBeNull();
  });

  it('renders a table with header and body cells', () => {
    const el = renderDocMarkdown(document, result('| A | B |\n| - | - |\n| 1 | 2 |'));
    const table = el.querySelector('table.docs-md-table')!;
    expect(table.querySelectorAll('thead th').length).toBe(2);
    expect(table.querySelectorAll('tbody td').length).toBe(2);
    expect(table.querySelector('thead th')!.textContent).toBe('A');
    expect(table.querySelector('tbody td')!.textContent).toBe('1');
  });

  it('overall truncated:true renders a quiet trailing note', () => {
    const el = renderDocMarkdown(document, { blocks: [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'x' }] }], truncated: true });
    const note = el.querySelector('.docs-md-truncated')!;
    expect(note).not.toBeNull();
    expect(note.textContent).toBe('Content truncated.');
  });

  it('truncated:false renders no trailing note', () => {
    const el = renderDocMarkdown(document, result('hello'));
    expect(el.querySelector('.docs-md-truncated')).toBeNull();
  });
});

describe('renderDocMarkdown — admonitions', () => {
  it('renders an <aside> with a variant class and nested block content', () => {
    const el = renderDocMarkdown(document, result(':::tip\nbe careful\n:::'));
    const aside = el.querySelector('aside.docs-md-admonition')!;
    expect(aside).not.toBeNull();
    expect(aside.classList.contains('docs-md-admonition-tip')).toBe(true);
    expect(aside.querySelector('.docs-md-admonition-title')).toBeNull();
    expect(aside.querySelector('p.docs-md-p')!.textContent).toBe('be careful');
  });

  it('renders an optional title line', () => {
    const el = renderDocMarkdown(document, result(':::warning Heads up\nwatch out\n:::'));
    const aside = el.querySelector('aside.docs-md-admonition-warning')!;
    expect(aside.querySelector('.docs-md-admonition-title')!.textContent).toBe('Heads up');
  });

  it('renders nested blocks (heading, list) inside the admonition', () => {
    const el = renderDocMarkdown(document, result(':::note\n## H\n- a\n- b\n:::'));
    const aside = el.querySelector('aside.docs-md-admonition-note')!;
    expect(aside.querySelector('h5.docs-md-h')!.textContent).toBe('H');
    expect(aside.querySelectorAll('li').length).toBe(2);
  });
});

describe('renderDocMarkdown — inline rendering', () => {
  it('renders strong, em, inline code, and text as their own leaf elements', () => {
    const el = renderDocMarkdown(document, result('a **b** *c* `d` ~~e~~ f'));
    const p = el.querySelector('p')!;
    expect(p.querySelector('strong')!.textContent).toBe('b');
    expect(p.querySelector('em')!.textContent).toBe('c');
    expect(p.querySelector('code')!.textContent).toBe('d');
    expect(p.querySelector('del')!.textContent).toBe('e');
    expect(p.textContent).toBe('a b c d e f');
  });

  it('renders an approved link with href verbatim, target=_blank, rel=noopener noreferrer', () => {
    const el = renderDocMarkdown(document, result('see [docs](https://clickhouse.com/docs/x)'));
    const a = el.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://clickhouse.com/docs/x');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('docs');
  });

  it('a rejected-scheme link never becomes an <a> — renders as literal text', () => {
    const el = renderDocMarkdown(document, result('see [bad](javascript:alert(1))'));
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('bad');
  });
});

describe('renderDocMarkdown — code blocks', () => {
  it('an SQL-tagged fence with a codeViewer option mounts the injected CodeViewer, not a <pre>', () => {
    const factory = vi.fn((opts: CodeViewerOptions) => {
      opts.parent.appendChild(document.createElement('div'));
      return fakeViewer();
    });
    const registered: CodeViewerHandle[] = [];
    const opts: DocMarkdownViewOptions = {
      codeViewer: { factory, languageExtension: [] },
      registerViewer: (v) => registered.push(v),
    };
    const el = renderDocMarkdown(document, result('```sql\nSELECT 1\n```'), opts);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ text: 'SELECT 1', language: 'sql' }));
    expect(el.querySelector('.docs-md-code-cm')).not.toBeNull();
    expect(el.querySelector('.docs-md-code-plain')).toBeNull();
    expect(registered).toHaveLength(1);
  });

  it('an SQL fence with NO codeViewer option falls back to plain <pre><code>', () => {
    const el = renderDocMarkdown(document, result('```sql\nSELECT 1\n```'));
    expect(el.querySelector('.docs-md-code-plain')!.textContent).toBe('SELECT 1');
    expect(el.querySelector('.docs-md-code-cm')).toBeNull();
  });

  it('a non-SQL-language fence renders as plain preformatted text even with a codeViewer option', () => {
    const factory = vi.fn(() => fakeViewer());
    const el = renderDocMarkdown(document, result('```python\nprint(1)\n```'), { codeViewer: { factory, languageExtension: [] } });
    expect(factory).not.toHaveBeenCalled();
    expect(el.querySelector('.docs-md-code-plain')!.textContent).toBe('print(1)');
  });

  it('an untagged fence renders as plain preformatted text', () => {
    const el = renderDocMarkdown(document, result('```\nplain\n```'));
    expect(el.querySelector('.docs-md-code-plain')!.textContent).toBe('plain');
  });



  it('a truncated code block shows a quiet "(truncated)" note', () => {
    const big = 'x'.repeat(300_000);
    const el = renderDocMarkdown(document, result('```\n' + big + '\n```'));
    const notes = [...el.querySelectorAll('.docs-md-note')].map((n) => n.textContent);
    expect(notes).toContain('(truncated)');
  });

  it('a non-truncated code block shows no truncation note', () => {
    const el = renderDocMarkdown(document, result('```\nshort\n```'));
    expect(el.querySelector('.docs-md-code .docs-md-note')).toBeNull();
  });
});
